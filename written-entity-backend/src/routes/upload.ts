import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import multer from 'multer';
import { runPipeline } from '../agents/orchestrator';
import { ensureDefaultUser, prisma } from '../db/prisma';
import { broadcast, broadcastLog } from '../socket';
import { userFromRequest } from '../utils/supabaseAuth';

const uploadDir = process.platform === 'win32' ? path.join(process.cwd(), 'uploads') : '/tmp/uploads';
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.mp3', '.mp4', '.wav', '.m4a', '.ogg', '.txt', '.vtt', '.webm'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  },
});

const router = Router();

// Rate limiting
const MAX_ACCOUNTS = 10;
const MAX_UPLOADS_PER_ACCOUNT = 3;

router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    let user;
    let meetingCount = 0;
    let totalAccounts = 1;
    
    // Try to get user and check limits, but continue if DB is unavailable
    try {
      user = await userFromRequest(req as any) ?? await ensureDefaultUser();
      totalAccounts = await prisma.user.count();
      meetingCount = await prisma.meeting.count({ where: { userId: user.id } });
      
      // Check global account limit
      if (totalAccounts > MAX_ACCOUNTS) {
        fs.unlinkSync(req.file.path);
        return res.status(503).json({ 
          error: `App has reached maximum capacity (${MAX_ACCOUNTS} accounts). This is a demo/judging limitation.`,
          maxAccounts: MAX_ACCOUNTS,
        });
      }
      
      // Check per-account upload limit
      if (meetingCount >= MAX_UPLOADS_PER_ACCOUNT) {
        fs.unlinkSync(req.file.path);
        return res.status(429).json({ 
          error: `Rate limit exceeded. Maximum ${MAX_UPLOADS_PER_ACCOUNT} meetings per account.`,
          limit: MAX_UPLOADS_PER_ACCOUNT,
          current: meetingCount,
        });
      }
    } catch (dbErr) {
      console.warn('Database unavailable, running in local mode without limits:', (dbErr as Error).message);
      user = { id: 'local-user', email: 'local@written-entity.dev', name: 'Local User' };
    }
    
    const attendees = safeJson(req.body.attendees, []);
    let meeting;
    
    // Try to create meeting in DB, or use in-memory fallback
    try {
      meeting = await prisma.meeting.create({
        data: {
          userId: user.id,
          title: req.body.title || req.file.originalname.replace(/\.[^.]+$/, ''),
          startTime: new Date(),
          attendees,
          status: 'PENDING',
        },
      });
    } catch (dbErr) {
      // Fallback: Create in-memory meeting ID
      const meetingId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      meeting = {
        id: meetingId,
        userId: user.id,
        title: req.body.title || req.file.originalname.replace(/\.[^.]+$/, ''),
        startTime: new Date(),
        attendees,
        status: 'PENDING',
      };
      console.log('Using in-memory meeting:', meeting.id);
    }

    const ext = path.extname(req.file.originalname);
    const finalPath = path.join(uploadDir, `${meeting.id}${ext}`);
    fs.renameSync(req.file.path, finalPath);
    
    // Try to update DB if available
    try {
      await prisma.meeting.update({ where: { id: meeting.id }, data: { uploadedFilePath: finalPath } });
    } catch (dbErr) {
      console.warn('Could not update meeting in DB, continuing in local mode');
    }

    broadcast({ type: 'meeting:created', data: { meetingId: meeting.id, title: meeting.title } });
    broadcastLog('orchestrator', `File uploaded: ${req.file.originalname} — pipeline starting (local mode)`);
    runPipeline(meeting.id).catch(console.error);
    return res.json({ 
      success: true, 
      meetingId: meeting.id, 
      message: 'Pipeline started (local mode - no database)',
      remaining: MAX_UPLOADS_PER_ACCOUNT - meetingCount - 1,
    });
  } catch (err: any) {
    console.error('Upload error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// Get user's remaining quota
router.get('/quota', async (req, res) => {
  try {
    let meetingCount = 0;
    let totalAccounts = 1;
    
    try {
      const user = await userFromRequest(req as any) ?? await ensureDefaultUser();
      meetingCount = await prisma.meeting.count({ where: { userId: user.id } });
      totalAccounts = await prisma.user.count();
    } catch (dbErr) {
      console.warn('Database unavailable for quota check, returning defaults');
    }
    
    return res.json({
      limit: MAX_UPLOADS_PER_ACCOUNT,
      used: meetingCount,
      remaining: Math.max(0, MAX_UPLOADS_PER_ACCOUNT - meetingCount),
      globalAccounts: totalAccounts,
      maxAccounts: MAX_ACCOUNTS,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

function safeJson(value: string | undefined, fallback: unknown) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export default router;
