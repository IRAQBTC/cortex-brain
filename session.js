#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG = {
  cortexDir: path.join(process.cwd(), '.cortex'),
  sessionFile: path.join(process.cwd(), '.cortex', 'current-session.json'),
  decisionsFile: path.join(process.cwd(), '.cortex', 'DECISIONS.md'),
  lessonsFile: path.join(process.cwd(), '.cortex', 'LESSONS.md'),
  contextFile: path.join(process.cwd(), 'CORTEX_CONTEXT.md')
};

// 1. ضمان وجود المجلد والملفات الأساسية
function ensureSetup() {
  if (!fs.existsSync(CONFIG.cortexDir)) fs.mkdirSync(CONFIG.cortexDir, { recursive: true });
  if (!fs.existsSync(CONFIG.decisionsFile)) fs.writeFileSync(CONFIG.decisionsFile, '# 📜 Project Decisions Log\n\n');
  if (!fs.existsSync(CONFIG.lessonsFile)) fs.writeFileSync(CONFIG.lessonsFile, '# 💡 Lessons Learned\n\n');
}

// 2. تحميل آمن مع آلية استرداد (Self-Healing)
function loadSession() {
  ensureSetup();
  if (!fs.existsSync(CONFIG.sessionFile)) return createNewSession();
  
  try {
    return JSON.parse(fs.readFileSync(CONFIG.sessionFile, 'utf8'));
  } catch (error) {
    console.warn('⚠️ Session file corrupted. Creating backup and starting fresh...');
    fs.copyFileSync(CONFIG.sessionFile, `${CONFIG.sessionFile}.bak.${Date.now()}`);
    return createNewSession();
  }
}

function createNewSession() {
  const session = {
    sessionId: `sess_${Date.now()}`,
    startedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    decisions: [],
    errors: [],
    lessons: [], // إضافة مهمة للتعلم طويل المدى
    nextSteps: []
  };
  saveSession(session);
  return session;
}

// 3. كتابة ذرية (Atomic Write) لمنع التلف
function saveSession(session) {
  session.lastUpdated = new Date().toISOString();
  const tempFile = `${CONFIG.sessionFile}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(session, null, 2));
  fs.renameSync(tempFile, CONFIG.sessionFile); // هذه العملية ذرية وآمنة 100%
}

// 4. إضافة قرار
function addDecision(text) {
  const session = loadSession();
  session.decisions.push({ timestamp: new Date().toISOString(), text });
  saveSession(session);
  fs.appendFileSync(CONFIG.decisionsFile, `\n- **[${new Date().toLocaleString()}]** ${text}`);
  console.log(`✅ Decision saved.`);
}

// 5. إضافة خطأ
function addError(text) {
  const session = loadSession();
  session.errors.push({ timestamp: new Date().toISOString(), text });
  saveSession(session);
  console.log(`✅ Error logged.`);
}

// 6. إضافة درس مستفاد (جديد ومهم)
function addLesson(text) {
  const session = loadSession();
  session.lessons.push({ timestamp: new Date().toISOString(), text });
  saveSession(session);
  fs.appendFileSync(CONFIG.lessonsFile, `\n- **[${new Date().toLocaleString()}]** ${text}`);
  console.log(`✅ Lesson logged.`);
}

// 7. إضافة خطوة تالية
function addNextStep(text) {
  const session = loadSession();
  session.nextSteps.push({ timestamp: new Date().toISOString(), text, done: false });
  saveSession(session);
  console.log(`✅ Next step added.`);
}

// 8. توليد السياق (يدعم وضعين: بشري وذكاء اصطناعي)
function generateContext(mode = 'human') {
  const session = loadSession();
  
  if (mode === 'human') {
    let md = `# 🧠 Cortex Session Context\n\n**Session ID:** ${session.sessionId}\n**Last Updated:** ${new Date(session.lastUpdated).toLocaleString()}\n\n`;
    md += `## 🎯 Decisions\n${session.decisions.map(d => `- ${d.text}`).join('\n') || '- None'}\n\n`;
    md += `## 🚧 Errors\n${session.errors.map(e => `- ${e.text}`).join('\n') || '- None'}\n\n`;
    md += `## 💡 Lessons\n${session.lessons.map(l => `- ${l.text}`).join('\n') || '- None'}\n\n`;
    md += `## ⏭️ Next Steps\n${session.nextSteps.map(n => `- [${n.done ? 'x' : ' '}] ${n.text}`).join('\n') || '- None'}\n`;
    
    fs.writeFileSync(CONFIG.contextFile, md);
    console.log(`✅ Human context generated: ${CONFIG.contextFile}`);
  } else if (mode === 'llm') {
    // وضع موفر للـ Tokens للوكلاء الذكيين
    const out = [
      `[CORTEX HANDOFF | ID: ${session.sessionId}]`,
      session.decisions.length ? `DECISIONS: ${session.decisions.map(d => d.text).join(' | ')}` : '',
      session.errors.length ? `ERRORS: ${session.errors.map(e => e.text).join(' | ')}` : '',
      session.lessons.length ? `LESSONS: ${session.lessons.map(l => l.text).join(' | ')}` : '',
      session.nextSteps.length ? `NEXT: ${session.nextSteps.filter(n => !n.done).map(n => n.text).join(' | ')}` : ''
    ].filter(Boolean).join('\n');
    console.log(out);
  }
}

// ==========================================
// واجهة سطر الأوامر
// ==========================================
const args = process.argv.slice(2);
const command = args[0];
const text = args.slice(1).join(' ');

ensureSetup();

switch (command) {
  case 'init': 
    createNewSession(); 
    console.log('✅ Session initialized.'); 
    break;
  case 'decision': 
    if (!text) return console.log('❌ Usage: node session.js decision "text"'); 
    addDecision(text); 
    break;
  case 'error': 
    if (!text) return console.log('❌ Usage: node session.js error "text"'); 
    addError(text); 
    break;
  case 'lesson': 
    if (!text) return console.log('❌ Usage: node session.js lesson "text"'); 
    addLesson(text); 
    break;
  case 'next': 
    if (!text) return console.log('❌ Usage: node session.js next "text"'); 
    addNextStep(text); 
    break;
  case 'context': 
    generateContext('human'); 
    break;
  case 'handoff': 
    generateContext('llm'); 
    break;
  default:
    console.log(`
🧠 Cortex Session Manager
Usage:
  node session.js init              - Start new session
  node session.js decision "text"   - Log a decision
  node session.js error "text"      - Log an error
  node session.js lesson "text"     - Log a lesson learned
  node session.js next "text"       - Log a next step
  node session.js context           - Generate readable Markdown
  node session.js handoff           - Print compact context for AI Agents
  `);
}