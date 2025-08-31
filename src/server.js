require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const connection = new IORedis(process.env.REDIS_URL);
const queue = new Queue('media-jobs', { connection });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

const app = express();
app.use(express.json());

// Serve a tiny frontend and uploaded files
app.use('/uploads', express.static(path.resolve(UPLOAD_DIR)));
app.use(express.static(path.resolve(__dirname, '..', 'public')));

app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required' });

  const jobId = uuidv4();
  const filePath = path.join(UPLOAD_DIR, req.file.filename);
  // read optional merge options from the multipart form
  const mergeMode = req.body && req.body.mergeMode ? req.body.mergeMode : undefined;
  const burnSubtitles = req.body && typeof req.body.burnSubtitles !== 'undefined' ? req.body.burnSubtitles : undefined;
  const enhance = req.body && typeof req.body.enhance !== 'undefined' ? req.body.enhance : undefined;

  const jobData = { id: jobId, path: filePath, originalname: req.file.originalname };
  if (mergeMode) jobData.mergeMode = mergeMode;
  if (typeof burnSubtitles !== 'undefined') jobData.burnSubtitles = burnSubtitles;
  if (typeof enhance !== 'undefined') jobData.enhance = enhance;
  const job = await queue.add('process-video', jobData);

  res.json({ jobId: job.id, status: 'queued' });
});

app.get('/job/:id', async (req, res) => {
  const job = await queue.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  const state = await job.getState();
  const progress = job.progress || 0;
  // include return value if job completed
  const result = job.returnvalue || null;
  res.json({ id: job.id, name: job.name, data: job.data, state, progress, result });
});

// Download an output file safely by filename
app.get('/download/:name', (req, res) => {
  const name = req.params.name;
  const filePath = path.join(UPLOAD_DIR, path.basename(name));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'file not found' });
  res.download(filePath);
});

app.get('/', (req, res) => res.send('AIWeb starter - upload endpoint: POST /upload (form field "file")'));

app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));