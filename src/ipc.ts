import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import { AvailableGroup } from './container-runner.js';
import {
  createProject,
  createTask,
  deleteProject,
  deleteTask,
  getActiveProjects,
  getAllProjects,
  getProjectById,
  getProjectsForGroup,
  getTaskById,
  updateProject,
  updateTask,
} from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  searchCalendarEvents,
  createCalendarEvent,
  updateCalendarEvent,
} from './calendar.js';
import { draftOutlookEmail, searchOutlookEmails } from './outlook.js';
import { Project, RegisteredGroup, WorkflowStep } from './types.js';

// ============================================================================
// Request/response verb dispatcher
// ============================================================================
//
// These IPC verbs use a request/response pattern: the agent writes a JSON
// file with `type`, `requestId`, and args; the host runs the handler and
// writes a matching response file at `<group>/responses/<requestId>.json`.
//
// To add a new verb: append an entry to REQUEST_HANDLERS and add a matching
// tool in container/agent-runner/src/ipc-mcp-stdio.ts that writes the
// request file and polls for the response.
//
// Fire-and-forget verbs (e.g. `message`, `draft_outlook_email`) do NOT use
// this dispatcher — they're handled inline in processIpcFiles.

interface RequestHandler {
  type: string;
  mainOnly: boolean;
  /** Human-readable action name used in the unauthorized-attempt error. */
  description: string;
  /** Returns the response payload; it's merged with `{ requestId }`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle: (data: any) => Promise<Record<string, unknown>>;
}

const REQUEST_HANDLERS: RequestHandler[] = [
  {
    type: 'archive_email',
    mainOnly: true,
    description: 'archive emails',
    handle: async (data) => {
      const { graphPost } = await import('./m365-auth.js');
      await graphPost(`/me/messages/${data.messageId}/move`, {
        destinationId: 'archive',
      });
      return { success: true };
    },
  },
  {
    type: 'search_emails',
    mainOnly: true,
    description: 'search emails',
    handle: async (data) => {
      const results = await searchOutlookEmails({
        query: data.query,
        from: data.from,
        subject: data.subject,
        after: data.after,
        before: data.before,
        top: data.top ? parseInt(data.top, 10) : undefined,
      });
      return { results, totalCount: results.length };
    },
  },
  {
    type: 'search_calendar',
    mainOnly: true,
    description: 'search calendar',
    handle: async (data) => {
      const results = await searchCalendarEvents({
        after: data.after,
        before: data.before,
        query: data.query,
        attendee: data.attendee,
        top: data.top ? parseInt(data.top, 10) : undefined,
      });
      return { results, totalCount: results.length };
    },
  },
  {
    type: 'create_calendar_event',
    mainOnly: true,
    description: 'create calendar events',
    handle: async (data) => {
      const result = await createCalendarEvent({
        subject: data.subject,
        start: data.start,
        end: data.end,
        attendees: data.attendees,
        body: data.body,
        location: data.location,
        isTeamsMeeting:
          data.isTeamsMeeting === true || data.isTeamsMeeting === 'true',
        isAllDay: data.isAllDay === true || data.isAllDay === 'true',
      });
      return { result };
    },
  },
  {
    type: 'update_calendar_event',
    mainOnly: true,
    description: 'update calendar events',
    handle: async (data) => {
      const isTeamsMeeting =
        data.isTeamsMeeting === true || data.isTeamsMeeting === 'true'
          ? true
          : data.isTeamsMeeting === false || data.isTeamsMeeting === 'false'
            ? false
            : undefined;
      const result = await updateCalendarEvent({
        eventId: data.eventId,
        subject: data.subject,
        start: data.start,
        end: data.end,
        attendees: data.attendees,
        body: data.body,
        location: data.location,
        isTeamsMeeting,
      });
      return { result };
    },
  },
  {
    type: 'gcloud_command',
    mainOnly: true,
    description: 'run gcloud commands',
    handle: async (data) => {
      if (!Array.isArray(data.command)) {
        throw new Error('command must be an array of strings');
      }
      const { runGcloudCommand } = await import('./gcloud.js');
      const result = await runGcloudCommand({
        command: data.command,
        projectId: data.projectId,
      });
      return { result };
    },
  },
];

/**
 * Atomically write `<requestId>.json` into the group's responses/ directory,
 * merging `payload` with `{ requestId }`. Uses a `.tmp` + rename so readers
 * never see a partial file.
 */
function writeResponseFile(
  ipcBaseDir: string,
  sourceGroup: string,
  requestId: string,
  payload: Record<string, unknown>,
): void {
  const responsesDir = path.join(ipcBaseDir, sourceGroup, 'responses');
  fs.mkdirSync(responsesDir, { recursive: true });
  const responseFile = path.join(responsesDir, `${requestId}.json`);
  const tempFile = `${responseFile}.tmp`;
  fs.writeFileSync(
    tempFile,
    JSON.stringify({ requestId, ...payload }, null, 2),
  );
  fs.renameSync(tempFile, responseFile);
}

/**
 * Enforce main-only auth (if required), run the handler, and write the
 * response (success or error) to the group's responses/ directory.
 */
async function dispatchRequestVerb(
  handler: RequestHandler,
  data: { requestId: string; [k: string]: unknown },
  isMain: boolean,
  sourceGroup: string,
  ipcBaseDir: string,
): Promise<void> {
  const { requestId } = data;
  const { type } = handler;

  if (handler.mainOnly && !isMain) {
    logger.warn(
      { sourceGroup, type },
      `Unauthorized ${type} attempt blocked (main only)`,
    );
    writeResponseFile(ipcBaseDir, sourceGroup, requestId, {
      error: `Only the main group can ${handler.description}`,
    });
    return;
  }

  try {
    const payload = await handler.handle(data);
    writeResponseFile(ipcBaseDir, sourceGroup, requestId, payload);
    logger.info({ sourceGroup, type, requestId }, `IPC ${type} completed`);
  } catch (err) {
    logger.error({ sourceGroup, type, requestId, err }, `IPC ${type} failed`);
    writeResponseFile(ipcBaseDir, sourceGroup, requestId, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
  onProjectsChanged: () => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  // Rate limiting: track operations per group per minute
  const rateLimits = new Map<string, { count: number; resetAt: number }>();
  const MAX_OPS_PER_MINUTE = 30;

  function checkRateLimit(sourceGroup: string): boolean {
    const now = Date.now();
    let entry = rateLimits.get(sourceGroup);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + 60_000 };
      rateLimits.set(sourceGroup, entry);
    }
    entry.count++;
    if (entry.count > MAX_OPS_PER_MINUTE) {
      logger.warn(
        { sourceGroup, count: entry.count },
        'IPC rate limit exceeded — dropping message',
      );
      return false;
    }
    return true;
  }

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              if (!checkRateLimit(sourceGroup)) {
                // Rate limited — move to errors
                const errorDir = path.join(ipcBaseDir, 'errors');
                fs.mkdirSync(errorDir, { recursive: true });
                fs.renameSync(
                  filePath,
                  path.join(errorDir, `ratelimit-${sourceGroup}-${file}`),
                );
                continue;
              }
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (
                data.type === 'draft_outlook_email' &&
                data.fromAlias &&
                data.to &&
                data.subject &&
                data.body
              ) {
                if (!isMain) {
                  logger.warn(
                    { sourceGroup },
                    'Unauthorized draft_outlook_email attempt blocked (main only)',
                  );
                } else
                  try {
                    const draftId = await draftOutlookEmail({
                      fromAlias: data.fromAlias,
                      to: data.to,
                      cc: data.cc,
                      subject: data.subject,
                      body: data.body,
                      inReplyTo: data.inReplyTo,
                      conversationId: data.conversationId,
                    });
                    logger.info(
                      {
                        from: data.fromAlias,
                        to: data.to,
                        sourceGroup,
                        draftId,
                      },
                      'IPC outlook email draft saved',
                    );
                  } catch (err) {
                    logger.error(
                      { from: data.fromAlias, to: data.to, sourceGroup, err },
                      'IPC outlook email draft failed',
                    );
                  }
              } else if (
                REQUEST_HANDLERS.some((h) => h.type === data.type) &&
                typeof data.requestId === 'string'
              ) {
                const handler = REQUEST_HANDLERS.find(
                  (h) => h.type === data.type,
                )!;
                await dispatchRequestVerb(
                  handler,
                  data,
                  isMain,
                  sourceGroup,
                  ipcBaseDir,
                );
              } else if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              if (!checkRateLimit(sourceGroup)) {
                const errorDir = path.join(ipcBaseDir, 'errors');
                fs.mkdirSync(errorDir, { recursive: true });
                fs.renameSync(
                  filePath,
                  path.join(errorDir, `ratelimit-${sourceGroup}-${file}`),
                );
                continue;
              }
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For projects
    projectId?: string;
    description?: string;
    workflow?: WorkflowStep[];
    current_step?: number;
    status?: string;
    check_interval_ms?: number;
    requestId?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'create_project': {
      if (!data.name || !data.workflow || !Array.isArray(data.workflow)) {
        logger.warn(
          { sourceGroup },
          'Invalid create_project: missing name or workflow',
        );
        break;
      }
      const projectTargetJid = data.targetJid || data.chatJid;
      if (!projectTargetJid) {
        logger.warn(
          { sourceGroup },
          'create_project: missing targetJid/chatJid',
        );
        break;
      }
      const targetGroup = registeredGroups[projectTargetJid];
      if (!targetGroup) {
        logger.warn(
          { projectTargetJid },
          'create_project: target group not registered',
        );
        break;
      }
      if (!isMain && targetGroup.folder !== sourceGroup) {
        logger.warn(
          { sourceGroup },
          'Unauthorized create_project attempt blocked',
        );
        break;
      }
      const projectId =
        data.projectId ||
        `proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();
      const project: Project = {
        id: projectId,
        group_folder: targetGroup.folder,
        chat_jid: projectTargetJid,
        name: data.name,
        description: data.description || '',
        workflow: data.workflow,
        current_step: 0,
        status: 'pending_approval',
        check_interval_ms: data.check_interval_ms || 300000,
        checker_task_id: null,
        created_at: now,
        updated_at: now,
      };
      createProject(project);
      logger.info(
        { projectId, sourceGroup, name: data.name },
        'Project created via IPC',
      );

      // Write response if requestId provided
      if (data.requestId) {
        const responsesDir = path.join(
          DATA_DIR,
          'ipc',
          sourceGroup,
          'responses',
        );
        fs.mkdirSync(responsesDir, { recursive: true });
        fs.writeFileSync(
          path.join(responsesDir, `${data.requestId}.json`),
          JSON.stringify({
            requestId: data.requestId,
            projectId,
            status: 'pending_approval',
          }),
        );
      }
      deps.onProjectsChanged();
      break;
    }

    case 'approve_project': {
      if (!data.projectId) break;
      const proj = getProjectById(data.projectId);
      if (!proj) {
        logger.warn(
          { projectId: data.projectId },
          'approve_project: not found',
        );
        break;
      }
      if (!isMain && proj.group_folder !== sourceGroup) {
        logger.warn({ sourceGroup }, 'Unauthorized approve_project attempt');
        break;
      }
      if (proj.status !== 'pending_approval') {
        logger.warn(
          { projectId: data.projectId, status: proj.status },
          'Project not pending approval',
        );
        break;
      }

      // Activate the project
      updateProject(data.projectId, { status: 'active' });

      // Create a checker scheduled task for this project
      const checkerTaskId = `proj-checker-${data.projectId}`;
      const checkerJid = proj.chat_jid;
      const checkerPrompt = `You are checking on an active workflow project. Read the current projects from /workspace/ipc/current_projects.json. Find the project with id "${data.projectId}" and check its current step. Based on the step type and check_config, take the appropriate action:\n\n- If the current step is type "action": execute the action described in the step, then advance to the next step by writing an IPC file.\n- If the current step is type "wait_for" or "check": check whether the condition is met (e.g. search emails, check calendar). If met, advance. If not, do nothing (will check again next run).\n- If the current step is type "notify": send a notification to the user via IPC message, then advance.\n\nAlways update the project status via IPC after any changes. If all steps are completed, mark the project as completed.\n\nProject: ${proj.name}\nDescription: ${proj.description}`;

      createTask({
        id: checkerTaskId,
        group_folder: proj.group_folder,
        chat_jid: checkerJid,
        prompt: checkerPrompt,
        schedule_type: 'interval',
        schedule_value: String(proj.check_interval_ms),
        context_mode: 'group',
        next_run: new Date(Date.now() + 5000).toISOString(), // Run almost immediately
        status: 'active',
        created_at: new Date().toISOString(),
      });

      updateProject(data.projectId, { checker_task_id: checkerTaskId });
      logger.info(
        { projectId: data.projectId, checkerTaskId },
        'Project approved and checker task created',
      );
      deps.onTasksChanged();
      deps.onProjectsChanged();
      break;
    }

    case 'update_project': {
      if (!data.projectId) break;
      const proj = getProjectById(data.projectId);
      if (!proj) {
        logger.warn({ projectId: data.projectId }, 'update_project: not found');
        break;
      }
      if (!isMain && proj.group_folder !== sourceGroup) {
        logger.warn({ sourceGroup }, 'Unauthorized update_project attempt');
        break;
      }

      const projUpdates: Parameters<typeof updateProject>[1] = {};
      if (data.workflow !== undefined) projUpdates.workflow = data.workflow;
      if (data.current_step !== undefined)
        projUpdates.current_step = data.current_step;
      if (data.status !== undefined)
        projUpdates.status = data.status as Project['status'];
      if (data.name !== undefined) projUpdates.name = data.name;
      if (data.description !== undefined)
        projUpdates.description = data.description;
      if (data.check_interval_ms !== undefined)
        projUpdates.check_interval_ms = data.check_interval_ms;

      updateProject(data.projectId, projUpdates);

      // If project completed or cancelled, clean up checker task
      if (data.status === 'completed' || data.status === 'cancelled') {
        if (proj.checker_task_id) {
          const task = getTaskById(proj.checker_task_id);
          if (task) {
            deleteTask(proj.checker_task_id);
            logger.info(
              { checkerTaskId: proj.checker_task_id },
              'Checker task cleaned up',
            );
            deps.onTasksChanged();
          }
        }
      }

      logger.info(
        { projectId: data.projectId, sourceGroup },
        'Project updated via IPC',
      );
      deps.onProjectsChanged();

      if (data.requestId) {
        const responsesDir = path.join(
          DATA_DIR,
          'ipc',
          sourceGroup,
          'responses',
        );
        fs.mkdirSync(responsesDir, { recursive: true });
        fs.writeFileSync(
          path.join(responsesDir, `${data.requestId}.json`),
          JSON.stringify({ requestId: data.requestId, success: true }),
        );
      }
      break;
    }

    case 'get_projects': {
      if (!data.requestId) break;
      const responsesDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'responses');
      fs.mkdirSync(responsesDir, { recursive: true });

      const projects = isMain
        ? getAllProjects()
        : getProjectsForGroup(sourceGroup);
      const responseFile = path.join(responsesDir, `${data.requestId}.json`);
      const tempFile = `${responseFile}.tmp`;
      fs.writeFileSync(
        tempFile,
        JSON.stringify({ requestId: data.requestId, projects }, null, 2),
      );
      fs.renameSync(tempFile, responseFile);
      break;
    }

    case 'cancel_project': {
      if (!data.projectId) break;
      const proj = getProjectById(data.projectId);
      if (!proj) break;
      if (!isMain && proj.group_folder !== sourceGroup) {
        logger.warn({ sourceGroup }, 'Unauthorized cancel_project attempt');
        break;
      }
      updateProject(data.projectId, { status: 'cancelled' });
      if (proj.checker_task_id) {
        const task = getTaskById(proj.checker_task_id);
        if (task) {
          deleteTask(proj.checker_task_id);
          deps.onTasksChanged();
        }
      }
      logger.info(
        { projectId: data.projectId, sourceGroup },
        'Project cancelled via IPC',
      );
      deps.onProjectsChanged();
      break;
    }

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
