import fs from 'fs';
import path from 'path';

const STATE_DIR = path.resolve('logs');
const STATE_FILE = path.join(STATE_DIR, 'bot-state.json');

export function readBotState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function writeBotState(state) {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function getSymbolState(symbol) {
  const state = readBotState();
  return state[symbol] || {};
}

export function updateSymbolState(symbol, patch) {
  const state = readBotState();

  state[symbol] = {
    ...(state[symbol] || {}),
    ...patch,
    updatedAt: Date.now()
  };

  writeBotState(state);

  return state[symbol];
}