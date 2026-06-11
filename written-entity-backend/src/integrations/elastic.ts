import { AnalysisResult, TranscriptResult } from '../types';

const DEFAULT_INDEX = 'written-entity-meeting-memory';

export interface ElasticMemoryHit {
  id: string;
  score: number | null;
  title: string;
  summary: string | null;
  meetingId: string;
  startTime: string;
  actionItems: string[];
  risks: string[];
}

interface ElasticMeetingDocument {
  meetingId: string;
  userId: string;
  title: string;
  startTime: string;
  attendees: unknown;
  summary: string | null;
  transcript: string | null;
  decisions: string[];
  actionItems: string[];
  risks: string[];
  followUps: string[];
  taskTitles: string[];
  emailRecipients: string[];
  summaryDocUrl: string | null;
  indexedAt: string;
}

export function elasticStatus() {
  return {
    enabled: isElasticConfigured(),
    index: elasticIndex(),
    endpointConfigured: Boolean(process.env.ELASTICSEARCH_URL),
    mcpServerUrl: process.env.ELASTIC_MCP_SERVER_URL ?? null,
  };
}

export async function indexMeetingMemory(input: {
  meeting: {
    id: string;
    userId: string;
    title: string;
    startTime: Date;
    attendees: unknown;
    transcriptRaw: string | null;
    summaryDocUrl: string | null;
  };
  transcript: TranscriptResult;
  analysis: AnalysisResult;
  tasks: Array<{ title: string }>;
  emails: Array<{ toEmail: string }>;
}) {
  if (!isElasticConfigured()) return { indexed: false, reason: 'Elastic is not configured' };

  await ensureMeetingIndex();
  const doc: ElasticMeetingDocument = {
    meetingId: input.meeting.id,
    userId: input.meeting.userId,
    title: input.meeting.title,
    startTime: input.meeting.startTime.toISOString(),
    attendees: input.meeting.attendees,
    summary: input.analysis.summary,
    transcript: input.transcript.fullText || input.meeting.transcriptRaw,
    decisions: input.analysis.keyDecisions.map((decision) => decision.description),
    actionItems: input.analysis.actionItems.map((item) => item.title),
    risks: input.analysis.risks,
    followUps: input.analysis.followUps.map((item) => item.topic),
    taskTitles: input.tasks.map((task) => task.title),
    emailRecipients: input.emails.map((email) => email.toEmail),
    summaryDocUrl: input.meeting.summaryDocUrl,
    indexedAt: new Date().toISOString(),
  };

  await elasticRequest('PUT', `/${elasticIndex()}/_doc/${encodeURIComponent(input.meeting.id)}`, doc);
  return { indexed: true, index: elasticIndex(), documentId: input.meeting.id };
}

export async function searchMeetingMemories(input: {
  query: string;
  userId?: string;
  limit?: number;
}): Promise<ElasticMemoryHit[]> {
  if (!isElasticConfigured()) return [];

  await ensureMeetingIndex();
  const filters = input.userId ? [{ term: { userId: input.userId } }] : [];
  const body = {
    size: input.limit ?? 5,
    query: {
      bool: {
        filter: filters,
        should: [
          { match: { title: { query: input.query, boost: 3 } } },
          { match: { summary: { query: input.query, boost: 2 } } },
          { match: { transcript: input.query } },
          { match: { actionItems: input.query } },
          { match: { risks: input.query } },
        ],
        minimum_should_match: 1,
      },
    },
    sort: [{ _score: 'desc' }, { startTime: 'desc' }],
  };

  const response = await elasticRequest<{ hits?: { hits?: Array<{ _id: string; _score: number | null; _source: ElasticMeetingDocument }> } }>(
    'POST',
    `/${elasticIndex()}/_search`,
    body,
  );

  return (response.hits?.hits ?? []).map((hit) => ({
    id: hit._id,
    score: hit._score,
    title: hit._source.title,
    summary: hit._source.summary,
    meetingId: hit._source.meetingId,
    startTime: hit._source.startTime,
    actionItems: hit._source.actionItems ?? [],
    risks: hit._source.risks ?? [],
  }));
}

async function ensureMeetingIndex() {
  try {
    await elasticRequest('HEAD', `/${elasticIndex()}`);
  } catch (err: any) {
    if (err?.status !== 404) throw err;
    await elasticRequest('PUT', `/${elasticIndex()}`, {
      mappings: {
        properties: {
          meetingId: { type: 'keyword' },
          userId: { type: 'keyword' },
          title: { type: 'text', fields: { keyword: { type: 'keyword' } } },
          startTime: { type: 'date' },
          attendees: { type: 'object', enabled: false },
          summary: { type: 'text' },
          transcript: { type: 'text' },
          decisions: { type: 'text' },
          actionItems: { type: 'text' },
          risks: { type: 'text' },
          followUps: { type: 'text' },
          taskTitles: { type: 'text' },
          emailRecipients: { type: 'keyword' },
          summaryDocUrl: { type: 'keyword', index: false },
          indexedAt: { type: 'date' },
        },
      },
    });
  }
}

async function elasticRequest<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const baseUrl = process.env.ELASTICSEARCH_URL?.replace(/\/+$/, '');
  if (!baseUrl) throw new Error('ELASTICSEARCH_URL is required');

  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (process.env.ELASTICSEARCH_API_KEY) headers.authorization = `ApiKey ${process.env.ELASTICSEARCH_API_KEY}`;
  if (!headers.authorization && process.env.ELASTICSEARCH_USERNAME && process.env.ELASTICSEARCH_PASSWORD) {
    const token = Buffer.from(`${process.env.ELASTICSEARCH_USERNAME}:${process.env.ELASTICSEARCH_PASSWORD}`).toString('base64');
    headers.authorization = `Basic ${token}`;
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (method === 'HEAD' && response.ok) return {} as T;
  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    const error = new Error(`Elastic ${method} ${path} failed: ${response.status} ${message}`);
    (error as any).status = response.status;
    throw error;
  }
  if (response.status === 204 || method === 'HEAD') return {} as T;
  return response.json() as Promise<T>;
}

function elasticIndex() {
  return process.env.ELASTICSEARCH_INDEX || DEFAULT_INDEX;
}

function isElasticConfigured() {
  return Boolean(process.env.ELASTICSEARCH_URL && (process.env.ELASTICSEARCH_API_KEY || process.env.ELASTICSEARCH_USERNAME));
}
