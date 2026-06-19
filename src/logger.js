import fs from 'fs';
import path from 'path';

const LOG_DIR = path.resolve('logs');
const LOG_FILE = path.join(LOG_DIR, 'signals.jsonl');

export function logJson(record) {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(LOG_FILE, JSON.stringify({ time: new Date().toISOString(), ...record }) + '\n');
}
