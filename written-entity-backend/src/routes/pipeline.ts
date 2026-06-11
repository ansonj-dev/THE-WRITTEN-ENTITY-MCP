import { Router } from 'express';
import { prisma } from '../db/prisma';
import { runPipeline } from '../agents/orchestrator';
import { elasticStatus, searchMeetingMemories } from '../integrations/elastic';
import { userFromRequest } from '../utils/supabaseAuth';

const router = Router();

router.post('/trigger', async (req, res) => {
  const { meetingId } = req.body;
  if (!meetingId) return res.status(400).json({ error: 'meetingId required' });
  runPipeline(meetingId).catch(console.error);
  return res.json({ success: true, message: 'Pipeline started', meetingId });
});

router.get('/status/:meetingId', async (req, res) => {
  const run = await prisma.pipelineRun.findFirst({
    where: { meetingId: req.params.meetingId },
    include: { steps: true },
    orderBy: { startedAt: 'desc' },
  });
  if (!run) return res.status(404).json({ error: 'No pipeline run found' });
  return res.json(run);
});

router.get('/meetings', async (req, res) => {
  const user = await userFromRequest(req as any).catch(() => null);
  const meetings = await prisma.meeting.findMany({
    where: user ? { userId: user.id } : undefined,
    include: {
      pipelineRun: { include: { steps: true } },
      tasks: true,
      emails: true,
    },
    orderBy: { startTime: 'desc' },
    take: 20,
  });
  return res.json(meetings);
});

router.get('/outputs/:meetingId', async (req, res) => {
  const meeting = await prisma.meeting.findUnique({
    where: { id: req.params.meetingId },
    include: { tasks: true, emails: true, pipelineRun: { include: { steps: true } } },
  });
  if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
  const elasticStep = meeting.pipelineRun?.steps.find((step) => step.agentName === 'elasticMemory');
  return res.json({
    summary: meeting.summaryText,
    analysis: meeting.analysis,
    tasks: meeting.tasks,
    emails: meeting.emails,
    summaryDocUrl: meeting.summaryDocUrl,
    elasticMemory: elasticStep?.output ?? null,
  });
});

router.get('/elastic/status', (_req, res) => {
  return res.json(elasticStatus());
});

router.get('/elastic/search', async (req, res) => {
  const query = String(req.query.q ?? '').trim();
  if (!query) return res.status(400).json({ error: 'q query parameter required' });

  const user = await userFromRequest(req as any).catch(() => null);
  try {
    const hits = await searchMeetingMemories({ query, userId: user?.id, limit: 5 });
    return res.json({ query, hits });
  } catch (err: any) {
    return res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
