import fs from 'fs';
import path from 'path';

import {
  Configuration,
  DeviceCodeRequest,
  LogLevel,
  PublicClientApplication,
} from '@azure/msal-node';
import { Client } from '@microsoft/microsoft-graph-client';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { STORE_DIR } from './config.js';

const TOKEN_CACHE_PATH = path.join(STORE_DIR, 'm365-token-cache.json');

let msalApp: PublicClientApplication | null = null;
let cachedAccount: string | null = null;

function getEnvConfig(): Record<string, string> {
  return readEnvFile(['M365_TENANT_ID', 'M365_CLIENT_ID']);
}

function hasCredentials(): boolean {
  const env = getEnvConfig();
  return !!(env.M365_TENANT_ID && env.M365_CLIENT_ID);
}

function getMsalApp(): PublicClientApplication | null {
  if (msalApp) return msalApp;
  if (!hasCredentials()) return null;

  const env = getEnvConfig();
  const config: Configuration = {
    auth: {
      clientId: env.M365_CLIENT_ID,
      authority: `https://login.microsoftonline.com/${env.M365_TENANT_ID}`,
    },
    system: {
      loggerOptions: {
        loggerCallback: (_level, message) => {
          logger.debug({ msal: true }, message);
        },
        logLevel: LogLevel.Warning,
        piiLoggingEnabled: false,
      },
    },
  };

  msalApp = new PublicClientApplication(config);

  // Restore token cache from disk
  if (fs.existsSync(TOKEN_CACHE_PATH)) {
    try {
      const cacheData = fs.readFileSync(TOKEN_CACHE_PATH, 'utf-8');
      msalApp.getTokenCache().deserialize(cacheData);
      logger.info('M365 token cache restored');
    } catch (err) {
      logger.warn({ err }, 'Failed to restore M365 token cache');
    }
  }

  return msalApp;
}

function persistCache(): void {
  if (!msalApp) return;
  try {
    fs.mkdirSync(path.dirname(TOKEN_CACHE_PATH), { recursive: true });
    fs.writeFileSync(
      TOKEN_CACHE_PATH,
      msalApp.getTokenCache().serialize(),
      'utf-8',
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to persist M365 token cache');
  }
}

// Delegated scopes (not /.default — that's for client credentials only)
const GRAPH_SCOPES = [
  'Chat.ReadWrite',
  'ChannelMessage.Read.All',
  'ChannelMessage.Send',
  'Mail.ReadWrite',
  'Mail.Send',
  'MailboxFolder.ReadWrite',
  'User.Read',
];

/**
 * Acquire a token silently using cached credentials.
 */
async function acquireTokenSilent(): Promise<string | null> {
  const app = getMsalApp();
  if (!app) return null;

  if (!cachedAccount) {
    const accounts = await app.getTokenCache().getAllAccounts();
    if (accounts.length === 0) return null;
    cachedAccount = accounts[0].homeAccountId;
  }

  const accounts = await app.getTokenCache().getAllAccounts();
  const account = accounts.find((a) => a.homeAccountId === cachedAccount);
  if (!account) {
    cachedAccount = null;
    return null;
  }

  try {
    const result = await app.acquireTokenSilent({
      account,
      scopes: GRAPH_SCOPES,
    });
    persistCache();
    return result?.accessToken || null;
  } catch {
    return null;
  }
}

/**
 * Run the device code auth flow.
 * Returns the access token on success, null on failure.
 */
export async function acquireTokenWithDeviceCode(): Promise<string | null> {
  const app = getMsalApp();
  if (!app) {
    logger.error('M365 credentials not configured');
    return null;
  }

  const request: DeviceCodeRequest = {
    scopes: GRAPH_SCOPES,
    deviceCodeCallback: (response) => {
      logger.info(
        {
          userCode: response.userCode,
          verificationUri: response.verificationUri,
        },
        'M365 device code auth: ' + response.message,
      );
      console.log('\n' + response.message + '\n');
    },
  };

  try {
    const result = await app.acquireTokenByDeviceCode(request);
    if (result?.account) {
      cachedAccount = result.account.homeAccountId;
    }
    persistCache();
    return result?.accessToken || null;
  } catch (err) {
    logger.error({ err }, 'M365 device code auth failed');
    return null;
  }
}

/**
 * Get a valid access token, using cached credentials if available.
 */
export async function getAccessToken(): Promise<string | null> {
  const token = await acquireTokenSilent();
  if (token) return token;

  logger.warn('No cached M365 token. Run device code auth first.');
  return null;
}

/**
 * Get an authenticated Microsoft Graph client, or null if M365 is not configured.
 */
export function getGraphClient(): Client | null {
  if (!hasCredentials()) return null;

  return Client.init({
    authProvider: async (done) => {
      const token = await getAccessToken();
      if (token) {
        done(null, token);
      } else {
        done(new Error('No M365 access token available'), null);
      }
    },
  });
}

export { hasCredentials as hasM365Credentials };

export async function graphGet<T = unknown>(apiPath: string): Promise<T> {
  const client = getGraphClient();
  if (!client) throw new Error('M365 not configured');
  return client.api(apiPath).get();
}

export async function graphPost<T = unknown>(
  apiPath: string,
  body: unknown,
): Promise<T> {
  const client = getGraphClient();
  if (!client) throw new Error('M365 not configured');
  return client.api(apiPath).post(body);
}

export async function graphPatch<T = unknown>(
  apiPath: string,
  body: unknown,
): Promise<T> {
  const client = getGraphClient();
  if (!client) throw new Error('M365 not configured');
  return client.api(apiPath).patch(body);
}
