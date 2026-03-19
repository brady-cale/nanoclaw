import { graphGet, graphPost, graphPatch } from './m365-auth.js';
import { TIMEZONE } from './config.js';
import { logger } from './logger.js';

// --- Types ---

interface GraphEvent {
  id: string;
  subject: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  location?: { displayName: string };
  attendees?: Array<{
    emailAddress: { name: string; address: string };
    status: { response: string };
    type: string;
  }>;
  organizer?: { emailAddress: { name: string; address: string } };
  bodyPreview?: string;
  body?: { contentType: string; content: string };
  isOnlineMeeting?: boolean;
  onlineMeeting?: { joinUrl: string };
  isAllDay?: boolean;
  webLink?: string;
}

// --- Search ---

export interface CalendarSearchParams {
  after: string;
  before: string;
  query?: string;
  attendee?: string;
  top?: number;
}

export interface CalendarSearchResult {
  id: string;
  subject: string;
  start: string;
  end: string;
  timeZone: string;
  location: string;
  attendees: Array<{ name: string; email: string; response: string }>;
  organizer: string;
  organizerEmail: string;
  bodyPreview: string;
  isOnlineMeeting: boolean;
  joinUrl: string | null;
  isAllDay: boolean;
}

function mapEvent(e: GraphEvent): CalendarSearchResult {
  return {
    id: e.id,
    subject: e.subject,
    start: e.start.dateTime,
    end: e.end.dateTime,
    timeZone: e.start.timeZone,
    location: e.location?.displayName || '',
    attendees: (e.attendees || []).map((a) => ({
      name: a.emailAddress.name,
      email: a.emailAddress.address,
      response: a.status.response,
    })),
    organizer: e.organizer?.emailAddress.name || '',
    organizerEmail: e.organizer?.emailAddress.address || '',
    bodyPreview: e.bodyPreview || '',
    isOnlineMeeting: e.isOnlineMeeting || false,
    joinUrl: e.onlineMeeting?.joinUrl || null,
    isAllDay: e.isAllDay || false,
  };
}

export async function searchCalendarEvents(
  params: CalendarSearchParams,
): Promise<CalendarSearchResult[]> {
  const top = Math.min(params.top || 20, 50);

  // Use calendarView for date-range queries (handles recurring events)
  let url = `/me/calendar/calendarView?startDateTime=${encodeURIComponent(params.after)}&endDateTime=${encodeURIComponent(params.before)}&$top=${top}&$orderby=start/dateTime&$select=id,subject,start,end,location,attendees,organizer,bodyPreview,isOnlineMeeting,onlineMeeting,isAllDay`;

  if (params.query) {
    url += `&$filter=contains(subject,'${params.query.replace(/'/g, "''")}')`;
  }

  const result = await graphGet<{ value: GraphEvent[] }>(url);
  let events = (result.value || []).map(mapEvent);

  // Client-side filter by attendee if specified
  if (params.attendee) {
    const attendeeEmail = params.attendee.toLowerCase();
    events = events.filter(
      (e) =>
        e.attendees.some((a) => a.email.toLowerCase() === attendeeEmail) ||
        e.organizerEmail.toLowerCase() === attendeeEmail,
    );
  }

  return events;
}

// --- Create ---

export interface CreateCalendarEventParams {
  subject: string;
  start: string;
  end: string;
  attendees?: string[];
  body?: string;
  location?: string;
  isTeamsMeeting?: boolean;
  isAllDay?: boolean;
}

export interface CreateCalendarEventResult {
  id: string;
  subject: string;
  start: string;
  end: string;
  joinUrl: string | null;
  webLink: string | null;
}

export async function createCalendarEvent(
  params: CreateCalendarEventParams,
): Promise<CreateCalendarEventResult> {
  const event: Record<string, unknown> = {
    subject: params.subject,
    start: {
      dateTime: params.start,
      timeZone: TIMEZONE,
    },
    end: {
      dateTime: params.end,
      timeZone: TIMEZONE,
    },
  };

  if (params.isAllDay) {
    event.isAllDay = true;
  }

  if (params.attendees?.length) {
    event.attendees = params.attendees.map((email) => ({
      emailAddress: { address: email },
      type: 'required',
    }));
  }

  if (params.body) {
    event.body = { contentType: 'text', content: params.body };
  }

  if (params.location) {
    event.location = { displayName: params.location };
  }

  if (params.isTeamsMeeting) {
    event.isOnlineMeeting = true;
    event.onlineMeetingProvider = 'teamsForBusiness';
  }

  const created = await graphPost<GraphEvent>('/me/calendar/events', event);

  logger.info(
    { eventId: created.id, subject: params.subject },
    'Calendar event created',
  );

  return {
    id: created.id,
    subject: created.subject,
    start: created.start.dateTime,
    end: created.end.dateTime,
    joinUrl: created.onlineMeeting?.joinUrl || null,
    webLink: created.webLink || null,
  };
}

// --- Update ---

export interface UpdateCalendarEventParams {
  eventId: string;
  subject?: string;
  start?: string;
  end?: string;
  attendees?: string[];
  body?: string;
  location?: string;
  isTeamsMeeting?: boolean;
}

export interface UpdateCalendarEventResult {
  id: string;
  subject: string;
  start: string;
  end: string;
  joinUrl: string | null;
}

export async function updateCalendarEvent(
  params: UpdateCalendarEventParams,
): Promise<UpdateCalendarEventResult> {
  const patch: Record<string, unknown> = {};

  if (params.subject !== undefined) {
    patch.subject = params.subject;
  }

  if (params.start !== undefined) {
    patch.start = { dateTime: params.start, timeZone: TIMEZONE };
  }

  if (params.end !== undefined) {
    patch.end = { dateTime: params.end, timeZone: TIMEZONE };
  }

  if (params.attendees !== undefined) {
    patch.attendees = params.attendees.map((email) => ({
      emailAddress: { address: email },
      type: 'required',
    }));
  }

  if (params.body !== undefined) {
    patch.body = { contentType: 'text', content: params.body };
  }

  if (params.location !== undefined) {
    patch.location = { displayName: params.location };
  }

  if (params.isTeamsMeeting !== undefined) {
    patch.isOnlineMeeting = params.isTeamsMeeting;
    if (params.isTeamsMeeting) {
      patch.onlineMeetingProvider = 'teamsForBusiness';
    }
  }

  const updated = await graphPatch<GraphEvent>(
    `/me/events/${params.eventId}`,
    patch,
  );

  logger.info(
    { eventId: params.eventId, subject: updated.subject },
    'Calendar event updated',
  );

  return {
    id: updated.id,
    subject: updated.subject,
    start: updated.start.dateTime,
    end: updated.end.dateTime,
    joinUrl: updated.onlineMeeting?.joinUrl || null,
  };
}
