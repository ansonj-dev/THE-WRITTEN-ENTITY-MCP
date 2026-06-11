import { prisma } from '../db/prisma';
import { elasticStatus, indexMeetingMemory, searchMeetingMemories } from '../integrations/elastic';
import { AnalysisResult, TranscriptResult } from '../types';

export async function runElasticMemory(
  meetingId: string,
  transcript: TranscriptResult,
  analysis: AnalysisResult,
  tasks: Array<{ title: string }>,
  emails: Array<{ toEmail: string }>,
) {
  const meeting = await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId } });
  const status = elasticStatus();

  if (!status.enabled) {
    return {
      enabled: false,
      indexed: false,
      relatedMemories: [],
      message: 'Elastic memory skipped because ELASTICSEARCH_URL and credentials are not configured.',
    };
  }

  const query = [meeting.title, analysis.summary, ...analysis.risks].filter(Boolean).join(' ');
  const relatedMemories = await searchMeetingMemories({ query, userId: meeting.userId, limit: 3 });
  const indexed = await indexMeetingMemory({ meeting, transcript, analysis, tasks, emails });

  return {
    enabled: true,
    indexed: indexed.indexed,
    index: status.index,
    relatedMemories,
    mcpServerUrl: status.mcpServerUrl,
    message: `Indexed meeting memory and found ${relatedMemories.length} related memories.`,
  };
}
