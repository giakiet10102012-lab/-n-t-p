import React, { useState, useCallback, useRef } from 'react';
import {
  Loader2, CheckCircle2, XCircle, History as HistoryIcon,
  RotateCcw, ArrowLeft, BookOpen, Calculator, Languages, ImagePlus
} from 'lucide-react';

const MODEL = 'claude-sonnet-4-6';
const MASTERY_THRESHOLD = 95;
const MAX_ATTEMPTS_PER_ITEM = 4;
const MAX_ITEMS = 6;
const SAFETY_QUESTION_CAP = 30;
const FIRST_CORRECT_GAIN = 50;
const SUBSEQUENT_CORRECT_GAIN = 40;
const WRONG_PENALTY = 30;

const CONTENT_TYPE_META = {
  vocabulary: { label: 'Từ vựng', Icon: Languages },
  grammar: { label: 'Ngữ pháp', Icon: BookOpen },
  math: { label: 'Toán', Icon: Calculator }
};

async function callClaude(contentBlocks, maxTokens = 1000) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: contentBlocks }]
    })
  });
  if (!response.ok) throw new Error(`Yêu cầu API thất bại (${response.status})`);
  const data = await response.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock || !textBlock.text) throw new Error('Không nhận được phản hồi hợp lệ');
  return textBlock.text;
}

function parseJSON(text) {
  const cleaned = text.replace(/```json\s*|```\s*$/g, '').trim();
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  const jsonStr = firstBrace >= 0 && lastBrace > firstBrace ? cleaned.slice(firstBrace, lastBrace + 1) : cleaned;
  return JSON.parse(jsonStr);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('Không đọc được ảnh'));
    reader.readAsDataURL(file);
  });
}

function normalizeText(s) {
  return (s || '').trim().toLowerCase();
}

function pickNextItem(items) {
  const eligible = items.filter(it => it.confidence < MASTERY_THRESHOLD && it.attempts < MAX_ATTEMPTS_PER_ITEM);
  if (eligible.length === 0) return null;
  const sorted = [...eligible].sort((a, b) => (a.confidence - b.confidence) || (a.attempts - b.attempts));
  return sorted[0];
}

function nextFormat(item) {
  return item.attempts % 2 === 0 ? 'multiple_choice' : 'short_answer';
}

function applyAnswerResult(item, wasCorrect) {
  const updated = { ...item, attempts: item.attempts + 1 };
  if (wasCorrect) {
    updated.correctCount = item.correctCount + 1;
    const gain = updated.correctCount === 1 ? FIRST_CORRECT_GAIN : SUBSEQUENT_CORRECT_GAIN;
    updated.confidence = Math.min(100, item.confidence + gain);
  } else {
    updated.confidence = Math.max(0, item.confidence - WRONG_PENALTY);
  }
  return updated;
}

function overallConfidence(items) {
  if (!items || items.length === 0) return 0;
  return Math.round(items.reduce((acc, it) => acc + it.confidence, 0) / items.length);
}

function ConfidenceGauge({ value, size = 56 }) {
  const stroke = 6;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = Math.max(0, Math.min(100, value));
  const offset = circumference * (1 - pct / 100);
  const mastered = pct >= MASTERY_THRESHOLD;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={radius} className="gauge-track" strokeWidth={stroke} fill="none" />
      <circle
        cx={size / 2} cy={size / 2} r={radius}
        className={`gauge-fill ${mastered ? 'gauge-fill--mastered' : ''}`}
        strokeWidth={stroke} fill="none"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="51%" textAnchor="middle" dominantBaseline="central" className="gauge-text">
        {pct}%
      </text>
    </svg>
  );
}

function MasteryStamp({ overall, achieved }) {
  return (
    <div className={`stamp ${achieved ? 'stamp--achieved' : ''}`}>
      <svg viewBox="0 0 160 160" width="140" height="140">
        <circle cx="80" cy="80" r="68" className="stamp-ring-outer" fill="none" strokeWidth="3" />
        <circle cx="80" cy="80" r="56" className="stamp-ring-inner" fill="none" strokeWidth="1.5" />
        <text x="80" y="75" textAnchor="middle" className="stamp-pct">{overall}%</text>
        <text x="80" y="98" textAnchor="middle" className="stamp-label">
          {achieved ? 'ĐÃ NẮM VỮNG' : 'CẦN ÔN THÊM'}
        </text>
      </svg>
    </div>
  );
}

export default function App() {
  const [screen, setScreen] = useState('upload');
  const [image, setImage] = useState(null);
  const [session, setSession] = useState(null);
  const [currentQuestion, setCurrentQuestion] = useState(null);
  const [selectedOption, setSelectedOption] = useState(null);
  const [shortAnswerText, setShortAnswerText] = useState('');
  const [feedback, setFeedback] = useState(null);
  const [questionLoading, setQuestionLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [totalAsked, setTotalAsked] = useState(0);
  const [historyList, setHistoryList] = useState(null);
  const [screenBeforeHistory, setScreenBeforeHistory] = useState('upload');
  const fileInputRef = useRef(null);

  const handleFileChange = useCallback(async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setError(null);
    if (file.size > 10 * 1024 * 1024) {
      setError('Ảnh quá lớn, thử ảnh dưới 10MB nhé.');
      return;
    }
    try {
      const base64 = await fileToBase64(file);
      const previewUrl = URL.createObjectURL(file);
      setImage({ base64, mediaType: file.type || 'image/jpeg', previewUrl });
    } catch (err) {
      setError('Không đọc được ảnh này, thử ảnh khác nhé.');
    }
  }, []);

  const loadNextQuestion = useCallback(async (sessionOverride) => {
    const activeSession = sessionOverride || session;
    if (!activeSession) return;
    const item = pickNextItem(activeSession.items);
    if (!item) {
      finishSession(activeSession);
      return;
    }
    setQuestionLoading(true);
    setFeedback(null);
    setSelectedOption(null);
    setShortAnswerText('');
    setError(null);
    try {
      const format = nextFormat(item);
      const prompt = `Bạn là gia sư AI. Tạo MỘT câu hỏi kiểm tra cho mục kiến thức sau, dựa trên loại nội dung "${activeSession.contentType}".
Mục: ${item.label} — ${item.detail}
Dạng câu hỏi: ${format === 'multiple_choice' ? 'trắc nghiệm 4 đáp án' : 'tự luận ngắn, học sinh tự gõ câu trả lời'}
Tránh lặp lại các câu đã hỏi trước đó về mục này: ${JSON.stringify(item.askedQuestions)}

CHỈ trả lời bằng JSON hợp lệ, không markdown, không giải thích thêm, đúng cấu trúc:
{
  "questionText": "câu hỏi bằng tiếng Việt, giữ nguyên thuật ngữ/số liệu tiếng Anh nếu có",
  "options": ${format === 'multiple_choice' ? '["...", "...", "...", "..."]' : 'null'},
  "correctAnswer": "đáp án đúng${format === 'multiple_choice' ? ', phải khớp chính xác một trong 4 lựa chọn trên' : ''}",
  "explanation": "giải thích ngắn gọn 1-2 câu, hiển thị sau khi trả lời"
}`;
      const text = await callClaude([{ type: 'text', text: prompt }], 1000);
      const parsed = parseJSON(text);
      setCurrentQuestion({
        itemId: item.id,
        format,
        questionText: parsed.questionText,
        options: parsed.options || null,
        correctAnswer: parsed.correctAnswer,
        explanation: parsed.explanation
      });
    } catch (err) {
      setError('Không tạo được câu hỏi tiếp theo. Thử lại nhé.');
    } finally {
      setQuestionLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const startAnalysis = useCallback(async () => {
    if (!image) return;
    setScreen('analyzing');
    setError(null);
    try {
      const prompt = `Bạn là gia sư AI phân tích ảnh bài tập của học sinh Việt Nam. Ảnh có thể chứa từ vựng tiếng Anh, ngữ pháp tiếng Anh, hoặc bài toán.

CHỈ trả lời bằng JSON hợp lệ, không markdown, không giải thích thêm, đúng cấu trúc:
{
  "contentType": "vocabulary" hoặc "grammar" hoặc "math",
  "topicSummary": "mô tả chủ đề bằng tiếng Việt, dưới 12 từ",
  "items": [
    { "id": "item_1", "label": "tên ngắn gọn", "detail": "nội dung đầy đủ và chính xác, tối đa 25 từ" }
  ]
}

Trích xuất tối đa ${MAX_ITEMS} mục kiến thức có thể kiểm tra riêng biệt từ ảnh. Chỉ dựa vào nội dung thật sự có trong ảnh, tuyệt đối không tự bịa thêm từ/quy tắc/bài toán không có trong ảnh. Nếu ảnh có nhiều hơn ${MAX_ITEMS} mục, chọn ra ${MAX_ITEMS} mục quan trọng/đại diện nhất.`;

      const text = await callClaude([
        { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
        { type: 'text', text: prompt }
      ], 1000);

      const parsed = parseJSON(text);
      if (!parsed.items || parsed.items.length === 0) throw new Error('empty');

      const items = parsed.items.slice(0, MAX_ITEMS).map((it, idx) => ({
        id: it.id || `item_${idx}`,
        label: it.label || `Mục ${idx + 1}`,
        detail: it.detail || '',
        confidence: 0,
        attempts: 0,
        correctCount: 0,
        askedQuestions: []
      }));
      const newSession = { contentType: parsed.contentType, topicSummary: parsed.topicSummary, items };
      setSession(newSession);
      setTotalAsked(0);
      setScreen('quiz');
      await loadNextQuestion(newSession);
    } catch (err) {
      setError('Không phân tích được ảnh này. Thử chụp rõ hơn hoặc ảnh khác nhé.');
      setScreen('upload');
    }
  }, [image, loadNextQuestion]);

  const recordItemResult = useCallback((itemId, wasCorrect, questionTextAsked) => {
    setSession(prev => {
      if (!prev) return prev;
      const items = prev.items.map(it => {
        if (it.id !== itemId) return it;
        const updated = applyAnswerResult(it, wasCorrect);
        updated.askedQuestions = [...it.askedQuestions, questionTextAsked].slice(-3);
        return updated;
      });
      return { ...prev, items };
    });
  }, []);

  const handleSelectMC = useCallback((option) => {
    if (feedback || !currentQuestion) return;
    setSelectedOption(option);
    const wasCorrect = normalizeText(option) === normalizeText(currentQuestion.correctAnswer);
    setFeedback({ correct: wasCorrect, explanation: currentQuestion.explanation });
    setTotalAsked(n => n + 1);
    recordItemResult(currentQuestion.itemId, wasCorrect, currentQuestion.questionText);
  }, [feedback, currentQuestion, recordItemResult]);

  const handleSubmitShortAnswer = useCallback(async () => {
    if (!shortAnswerText.trim() || submitting || !currentQuestion) return;
    setSubmitting(true);
    setError(null);
    try {
      const prompt = `Chấm câu trả lời của học sinh.
Câu hỏi: ${currentQuestion.questionText}
Đáp án mong đợi: ${currentQuestion.correctAnswer}
Câu trả lời của học sinh: ${shortAnswerText}

Đánh giá linh hoạt: chấp nhận từ đồng nghĩa, cách diễn đạt tương đương, lỗi chính tả nhỏ không đổi nghĩa, hoặc biểu thức toán học tương đương về giá trị.
CHỈ trả lời bằng JSON hợp lệ:
{ "correct": true hoặc false, "feedback": "phản hồi ngắn gọn 1-2 câu bằng tiếng Việt, khích lệ, giải thích nếu sai" }`;
      const text = await callClaude([{ type: 'text', text: prompt }], 1000);
      const parsed = parseJSON(text);
      const wasCorrect = !!parsed.correct;
      setFeedback({ correct: wasCorrect, explanation: parsed.feedback || currentQuestion.explanation });
      setTotalAsked(n => n + 1);
      recordItemResult(currentQuestion.itemId, wasCorrect, currentQuestion.questionText);
    } catch (err) {
      setError('Không chấm được câu trả lời này. Thử lại nhé.');
    } finally {
      setSubmitting(false);
    }
  }, [shortAnswerText, submitting, currentQuestion, recordItemResult]);

  const finishSession = useCallback(async (sessionArg) => {
    const activeSession = sessionArg || session;
    if (!activeSession) return;
    setScreen('results');
    try {
      const record = {
        timestamp: Date.now(),
        contentType: activeSession.contentType,
        topicSummary: activeSession.topicSummary,
        overallConfidence: overallConfidence(activeSession.items),
        items: activeSession.items.map(it => ({ label: it.label, confidence: it.confidence }))
      };
      await window.storage.set(`sessions:${record.timestamp}`, JSON.stringify(record), false);
    } catch (err) {
      // lưu lịch sử thất bại không nên chặn việc hiển thị kết quả
    }
  }, [session]);

  const handleContinue = useCallback(() => {
    if (totalAsked >= SAFETY_QUESTION_CAP) {
      finishSession(session);
      return;
    }
    loadNextQuestion();
  }, [totalAsked, session, loadNextQuestion, finishSession]);

  const retryWeakItems = useCallback(() => {
    if (!session) return;
    const items = session.items.map(it => (it.confidence < MASTERY_THRESHOLD ? { ...it, attempts: 0 } : it));
    const updated = { ...session, items };
    setSession(updated);
    setScreen('quiz');
    loadNextQuestion(updated);
  }, [session, loadNextQuestion]);

  const resetToUpload = useCallback(() => {
    if (image && image.previewUrl) URL.revokeObjectURL(image.previewUrl);
    setScreen('upload');
    setImage(null);
    setSession(null);
    setCurrentQuestion(null);
    setFeedback(null);
    setError(null);
    setTotalAsked(0);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [image]);

  const openHistory = useCallback(async () => {
    setScreenBeforeHistory(screen);
    setScreen('history');
    setHistoryList(null);
    try {
      const listResult = await window.storage.list('sessions:', false);
      const keys = (listResult && listResult.keys) || [];
      const records = await Promise.all(keys.map(async (k) => {
        try {
          const r = await window.storage.get(k, false);
          return r ? JSON.parse(r.value) : null;
        } catch {
          return null;
        }
      }));
      setHistoryList(records.filter(Boolean).sort((a, b) => b.timestamp - a.timestamp));
    } catch (err) {
      setHistoryList([]);
    }
  }, [screen]);

  function renderUpload() {
    return (
      <div className="screen screen-upload">
        <p className="tagline">Chấm điểm bằng ảnh — ôn đến khi thật chắc</p>
        <label className="upload-zone" htmlFor="file-input">
          {image ? (
            <img src={image.previewUrl} alt="Ảnh bài tập đã chọn" className="upload-preview" />
          ) : (
            <>
              <ImagePlus size={40} strokeWidth={1.5} />
              <span className="upload-zone-title">Chạm để tải ảnh bài tập</span>
              <span className="upload-zone-sub">Từ vựng · Ngữ pháp · Toán</span>
            </>
          )}
        </label>
        <input
          id="file-input"
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleFileChange}
          style={{ display: 'none' }}
        />
        {image && (
          <button className="btn btn-primary" onClick={startAnalysis}>Bắt đầu phân tích</button>
        )}
      </div>
    );
  }

  function renderAnalyzing() {
    return (
      <div className="screen screen-center">
        <Loader2 className="spin" size={32} />
        <p className="loading-text">Đang đọc ảnh và tạo câu hỏi...</p>
      </div>
    );
  }

  function renderQuiz() {
    if (!session) return null;
    if (questionLoading || !currentQuestion) {
      return (
        <div className="screen screen-center">
          <Loader2 className="spin" size={28} />
          <p className="loading-text">Đang tạo câu hỏi tiếp theo...</p>
        </div>
      );
    }
    const currentItem = session.items.find(it => it.id === currentQuestion.itemId);
    const meta = CONTENT_TYPE_META[session.contentType] || CONTENT_TYPE_META.vocabulary;
    const isMC = currentQuestion.format === 'multiple_choice' && currentQuestion.options && currentQuestion.options.length > 0;

    return (
      <div className="screen screen-quiz">
        <div className="quiz-top">
          <button className="icon-btn" onClick={resetToUpload} aria-label="Thoát">
            <ArrowLeft size={18} />
          </button>
          <ConfidenceGauge value={overallConfidence(session.items)} />
        </div>

        {currentItem && (
          <div className="item-tag">
            <meta.Icon size={14} />
            <span>{currentItem.label}</span>
          </div>
        )}

        <div className="question-card">
          <p className="question-text">{currentQuestion.questionText}</p>
        </div>

        {isMC ? (
          <div className="options">
            {currentQuestion.options.map((opt, i) => {
              const isSelected = selectedOption === opt;
              const isCorrectOpt = normalizeText(opt) === normalizeText(currentQuestion.correctAnswer);
              const showState = !!feedback;
              const classes = [
                'option-btn',
                isSelected ? 'option-btn--selected' : '',
                showState && isCorrectOpt ? 'option-btn--correct' : '',
                showState && isSelected && !isCorrectOpt ? 'option-btn--wrong' : ''
              ].filter(Boolean).join(' ');
              return (
                <button key={i} className={classes} onClick={() => handleSelectMC(opt)} disabled={!!feedback}>
                  {opt}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="short-answer">
            <input
              type="text"
              className="text-input"
              value={shortAnswerText}
              onChange={(e) => setShortAnswerText(e.target.value)}
              placeholder="Gõ câu trả lời..."
              disabled={!!feedback || submitting}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSubmitShortAnswer(); }}
            />
            {!feedback && (
              <button
                className="btn btn-primary"
                onClick={handleSubmitShortAnswer}
                disabled={!shortAnswerText.trim() || submitting}
              >
                {submitting ? 'Đang chấm...' : 'Xác nhận'}
              </button>
            )}
          </div>
        )}

        {feedback && (
          <div className={`feedback ${feedback.correct ? 'feedback--correct' : 'feedback--wrong'}`}>
            <div className="feedback-head">
              {feedback.correct ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
              <span>{feedback.correct ? 'Chính xác!' : 'Chưa đúng'}</span>
            </div>
            {feedback.explanation && <p className="feedback-text">{feedback.explanation}</p>}
            <button className="btn btn-primary" onClick={handleContinue}>Tiếp tục</button>
          </div>
        )}
      </div>
    );
  }

  function renderResults() {
    if (!session) return null;
    const overall = overallConfidence(session.items);
    const achieved = overall >= MASTERY_THRESHOLD;
    const weakItems = session.items.filter(it => it.confidence < MASTERY_THRESHOLD);

    return (
      <div className="screen screen-results">
        <MasteryStamp overall={overall} achieved={achieved} />
        <p className="results-summary">
          {achieved
            ? 'Hệ thống tự tin bạn đã nắm vững nội dung này.'
            : `Đã kiểm tra xong — còn ${weakItems.length} phần nên ôn lại thêm.`}
        </p>
        <div className="item-list">
          {session.items.map(it => (
            <div key={it.id} className="item-row">
              <span className="item-row-label">{it.label}</span>
              <span className={`item-row-pct ${it.confidence >= MASTERY_THRESHOLD ? 'item-row-pct--good' : ''}`}>
                {it.confidence}%
              </span>
            </div>
          ))}
        </div>
        <div className="results-actions">
          {weakItems.length > 0 && (
            <button className="btn btn-primary" onClick={retryWeakItems}>
              <RotateCcw size={16} /> Luyện lại phần yếu
            </button>
          )}
          <button className="btn btn-secondary" onClick={resetToUpload}>Tải ảnh mới</button>
        </div>
      </div>
    );
  }

  function renderHistory() {
    return (
      <div className="screen screen-history">
        <div className="quiz-top">
          <button className="icon-btn" onClick={() => setScreen(screenBeforeHistory)} aria-label="Quay lại">
            <ArrowLeft size={18} />
          </button>
          <h2 className="section-title">Lịch sử luyện tập</h2>
          <span style={{ width: 36 }} />
        </div>
        {historyList === null && (
          <div className="screen-center">
            <Loader2 className="spin" size={24} />
          </div>
        )}
        {historyList && historyList.length === 0 && (
          <p className="empty-text">Chưa có phiên luyện tập nào. Tải ảnh đầu tiên lên để bắt đầu.</p>
        )}
        {historyList && historyList.length > 0 && (
          <div className="history-list">
            {historyList.map((rec) => {
              const meta = CONTENT_TYPE_META[rec.contentType] || CONTENT_TYPE_META.vocabulary;
              return (
                <div key={rec.timestamp} className="history-row">
                  <div className="history-row-icon"><meta.Icon size={16} /></div>
                  <div className="history-row-body">
                    <span className="history-row-title">{rec.topicSummary}</span>
                    <span className="history-row-date">{new Date(rec.timestamp).toLocaleDateString('vi-VN')}</span>
                  </div>
                  <span className={`history-row-pct ${rec.overallConfidence >= MASTERY_THRESHOLD ? 'item-row-pct--good' : ''}`}>
                    {rec.overallConfidence}%
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="app">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;700;800&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@500;600&display=swap');

        .app {
          --paper: #F5F7F2;
          --paper-line: #D9E0D5;
          --ink: #1E3550;
          --ink-soft: #5B7285;
          --red: #B8283A;
          --correct: #2F7A4F;
          --gold: #C98A2B;
          --card-bg: #FFFFFF;
          --radius: 14px;
          font-family: 'Inter', -apple-system, sans-serif;
          color: var(--ink);
          background-color: var(--paper);
          background-image: linear-gradient(var(--paper-line) 1px, transparent 1px), linear-gradient(90deg, var(--paper-line) 1px, transparent 1px);
          background-size: 22px 22px;
          min-height: 100vh;
          box-sizing: border-box;
          padding: 20px 16px 48px;
          max-width: 480px;
          margin: 0 auto;
        }
        .app * { box-sizing: border-box; }
        .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
        .wordmark { display: flex; align-items: baseline; gap: 8px; }
        .wordmark-num { font-family: 'IBM Plex Mono', monospace; font-weight: 600; font-size: 14px; color: var(--gold); background: rgba(201,138,43,0.12); padding: 2px 6px; border-radius: 6px; }
        .wordmark-text { font-family: 'Be Vietnam Pro', sans-serif; font-weight: 800; font-size: 19px; letter-spacing: -0.01em; }
        .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 10px; border: 1.5px solid var(--paper-line); background: var(--card-bg); color: var(--ink); cursor: pointer; transition: border-color .15s ease, transform .15s ease; flex-shrink: 0; }
        .icon-btn:hover { border-color: var(--ink-soft); }
        .icon-btn:active { transform: scale(0.94); }
        .error-banner { background: rgba(184,40,58,0.08); border: 1.5px solid rgba(184,40,58,0.25); color: var(--red); padding: 10px 12px; border-radius: 10px; font-size: 13.5px; margin-bottom: 16px; }
        .screen { animation: fadeIn .35s ease; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .screen-center { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 60px 0; }
        .spin { animation: spin .9s linear infinite; color: var(--ink-soft); }
        @keyframes spin { to { transform: rotate(360deg); } }
        .loading-text { color: var(--ink-soft); font-size: 14px; }
        .tagline { color: var(--ink-soft); font-size: 14px; margin: -8px 0 20px; }
        .upload-zone { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-height: 220px; border: 2px dashed var(--ink-soft); border-radius: var(--radius); background: var(--card-bg); color: var(--ink-soft); cursor: pointer; padding: 24px; text-align: center; transition: border-color .15s ease, background .15s ease; }
        .upload-zone:hover { border-color: var(--ink); }
        .upload-zone-title { font-family: 'Be Vietnam Pro', sans-serif; font-weight: 700; font-size: 15.5px; color: var(--ink); }
        .upload-zone-sub { font-size: 12.5px; letter-spacing: 0.02em; }
        .upload-preview { max-width: 100%; max-height: 260px; border-radius: 8px; object-fit: contain; }
        .btn { font-family: 'Be Vietnam Pro', sans-serif; font-weight: 700; font-size: 15px; border-radius: 10px; padding: 13px 18px; border: none; cursor: pointer; width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; transition: transform .12s ease, opacity .15s ease; }
        .btn:active { transform: scale(0.97); }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .btn-primary { background: var(--ink); color: #fff; margin-top: 16px; }
        .btn-secondary { background: transparent; color: var(--ink); border: 1.5px solid var(--paper-line); }
        .quiz-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
        .item-tag { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--ink-soft); background: var(--card-bg); border: 1px solid var(--paper-line); padding: 5px 10px; border-radius: 20px; margin-bottom: 12px; }
        .question-card { background: var(--card-bg); border: 1.5px solid var(--paper-line); border-radius: var(--radius); padding: 20px; margin-bottom: 16px; }
        .question-text { font-family: 'Be Vietnam Pro', sans-serif; font-weight: 600; font-size: 16.5px; line-height: 1.5; margin: 0; }
        .options { display: flex; flex-direction: column; gap: 10px; }
        .option-btn { text-align: left; padding: 13px 16px; border-radius: 10px; border: 1.5px solid var(--paper-line); background: var(--card-bg); font-family: 'Inter', sans-serif; font-size: 14.5px; color: var(--ink); cursor: pointer; transition: border-color .15s ease, background .15s ease; }
        .option-btn:hover:not(:disabled) { border-color: var(--ink-soft); }
        .option-btn--selected { border-color: var(--ink); }
        .option-btn--correct { border-color: var(--correct); background: rgba(47,122,79,0.08); color: var(--correct); }
        .option-btn--wrong { border-color: var(--red); background: rgba(184,40,58,0.08); color: var(--red); }
        .option-btn:disabled { cursor: default; }
        .short-answer { display: flex; flex-direction: column; }
        .text-input { padding: 13px 16px; border-radius: 10px; border: 1.5px solid var(--paper-line); font-family: 'Inter', sans-serif; font-size: 14.5px; color: var(--ink); background: var(--card-bg); width: 100%; }
        .text-input:focus { outline: 2px solid var(--ink); outline-offset: 1px; }
        .feedback { margin-top: 16px; padding: 16px; border-radius: var(--radius); border: 1.5px solid var(--paper-line); }
        .feedback--correct { background: rgba(47,122,79,0.06); border-color: rgba(47,122,79,0.3); }
        .feedback--wrong { background: rgba(184,40,58,0.06); border-color: rgba(184,40,58,0.3); }
        .feedback-head { display: flex; align-items: center; gap: 7px; font-family: 'Be Vietnam Pro', sans-serif; font-weight: 700; font-size: 14.5px; margin-bottom: 6px; }
        .feedback--correct .feedback-head { color: var(--correct); }
        .feedback--wrong .feedback-head { color: var(--red); }
        .feedback-text { font-size: 13.5px; color: var(--ink-soft); margin: 0 0 12px; line-height: 1.5; }
        .gauge-track { stroke: var(--paper-line); }
        .gauge-fill { stroke: var(--ink); transition: stroke-dashoffset .6s ease, stroke .3s ease; }
        .gauge-fill--mastered { stroke: var(--gold); }
        .gauge-text { font-family: 'IBM Plex Mono', monospace; font-weight: 600; fill: var(--ink); font-size: 14px; }
        .screen-results { display: flex; flex-direction: column; align-items: center; text-align: center; padding-top: 12px; }
        .stamp { animation: stampIn .5s cubic-bezier(.2,.9,.3,1.2); margin-bottom: 8px; }
        @keyframes stampIn { from { opacity: 0; transform: scale(1.4) rotate(-8deg); } to { opacity: 1; transform: scale(1) rotate(-4deg); } }
        .stamp-ring-outer { stroke: var(--ink); }
        .stamp-ring-inner { stroke: var(--ink); opacity: 0.5; }
        .stamp--achieved .stamp-ring-outer, .stamp--achieved .stamp-ring-inner { stroke: var(--gold); }
        .stamp-pct { font-family: 'IBM Plex Mono', monospace; font-weight: 700; font-size: 30px; fill: var(--ink); }
        .stamp--achieved .stamp-pct { fill: var(--gold); }
        .stamp-label { font-family: 'Be Vietnam Pro', sans-serif; font-weight: 700; font-size: 11px; letter-spacing: 0.08em; fill: var(--ink); }
        .stamp--achieved .stamp-label { fill: var(--gold); }
        .results-summary { color: var(--ink-soft); font-size: 14px; margin: 4px 0 20px; }
        .item-list { width: 100%; display: flex; flex-direction: column; gap: 8px; margin-bottom: 20px; }
        .item-row { display: flex; align-items: center; justify-content: space-between; background: var(--card-bg); border: 1.5px solid var(--paper-line); border-radius: 10px; padding: 11px 14px; font-size: 14px; text-align: left; }
        .item-row-pct { font-family: 'IBM Plex Mono', monospace; font-weight: 600; color: var(--red); }
        .item-row-pct--good { color: var(--correct); }
        .results-actions { width: 100%; display: flex; flex-direction: column; gap: 10px; }
        .section-title { font-family: 'Be Vietnam Pro', sans-serif; font-weight: 700; font-size: 16px; margin: 0; }
        .empty-text { color: var(--ink-soft); font-size: 14px; text-align: center; padding: 40px 20px; }
        .history-list { display: flex; flex-direction: column; gap: 8px; }
        .history-row { display: flex; align-items: center; gap: 10px; background: var(--card-bg); border: 1.5px solid var(--paper-line); border-radius: 10px; padding: 12px 14px; }
        .history-row-icon { color: var(--ink-soft); flex-shrink: 0; }
        .history-row-body { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .history-row-title { font-size: 13.5px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .history-row-date { font-size: 11.5px; color: var(--ink-soft); }
        .history-row-pct { font-family: 'IBM Plex Mono', monospace; font-weight: 600; color: var(--red); font-size: 14px; flex-shrink: 0; }
        @media (prefers-reduced-motion: reduce) {
          .screen, .stamp, .spin, .gauge-fill { animation: none !important; transition: none !important; }
        }
      `}</style>

      <div className="header">
        <div className="wordmark">
          <span className="wordmark-num">95%</span>
          <span className="wordmark-text">Nắm Chắc</span>
        </div>
        {screen !== 'history' && (
          <button className="icon-btn" onClick={openHistory} aria-label="Lịch sử">
            <HistoryIcon size={18} />
          </button>
        )}
      </div>

      {error && <div className="error-banner" role="alert">{error}</div>}

      {screen === 'upload' && renderUpload()}
      {screen === 'analyzing' && renderAnalyzing()}
      {screen === 'quiz' && renderQuiz()}
      {screen === 'results' && renderResults()}
      {screen === 'history' && renderHistory()}
    </div>
  );
}
