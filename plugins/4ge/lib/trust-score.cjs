'use strict';

const fs = require('fs');
const path = require('path');

const THRESHOLDS = { guided: 0, assisted: 10, autonomous: 25 };

class TrustScore {
  constructor(score = 0) {
    this._score = Math.max(0, score);
    this._history = [];
  }

  getScore() { return this._score; }

  getLevel() {
    if (this._score >= THRESHOLDS.autonomous) return 'autonomous';
    if (this._score >= THRESHOLDS.assisted) return 'assisted';
    return 'guided';
  }

  recordSuccess() {
    this._score += 1;
    this._history.push({ type: 'success', timestamp: new Date().toISOString(), score: this._score });
  }

  recordFailure() {
    this._score = Math.max(0, this._score - 2);
    this._history.push({ type: 'failure', timestamp: new Date().toISOString(), score: this._score });
  }

  reset() {
    this._score = 0;
    this._history.push({ type: 'reset', timestamp: new Date().toISOString(), score: 0 });
  }

  setScore(value) {
    this._score = Math.max(0, value);
    this._history.push({ type: 'set', timestamp: new Date().toISOString(), score: this._score });
  }

  getProgression() {
    const level = this.getLevel();
    const nextLevel = level === 'guided' ? 'assisted' : level === 'assisted' ? 'autonomous' : null;
    const nextThreshold = nextLevel ? THRESHOLDS[nextLevel] : null;
    const remaining = nextThreshold ? nextThreshold - this._score : 0;

    return { level, score: this._score, nextLevel, remaining };
  }

  save(filePath) {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({ score: this._score, history: this._history.slice(-100) }));
    } catch { /* best effort */ }
  }

  static load(filePath) {
    if (!fs.existsSync(filePath)) return new TrustScore();
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const raw = data.score;
      const score = (typeof raw === 'number' && raw >= 0 && raw <= 1000) ? raw : 0;
      const ts = new TrustScore(score);
      ts._history = Array.isArray(data.history) ? data.history : [];
      return ts;
    } catch {
      return new TrustScore();
    }
  }
}

module.exports = { TrustScore, THRESHOLDS };
