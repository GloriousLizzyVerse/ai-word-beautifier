import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { getRequestAccount } from '@/lib/account-auth';

export const maxDuration = 120;

const DEEPSEEK_MODEL = 'deepseek-flash';

type BoxAnn = { type: 'box'; label?: string; x: number; y: number; w: number; h: number };
type EllipseAnn = { type: 'ellipse'; label?: string; x: number; y: number; w: number; h: number };
type ArrowAnn = { type: 'arrow'; label?: string; x1: number; y1: number; x2: number; y2: number };
type TextAnn = { type: 'text'; text: string; x: number; y: number };
export type Annotation = BoxAnn | EllipseAnn | ArrowAnn | TextAnn;

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function clamp01(v: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(Math.max(v, 0), 1);
}

function toAnnotation(raw: any): Annotation | null {
  const t = raw?.type;
  if (t === 'box' || t === 'ellipse') {
    let x = num(raw.x, 0);
    let y = num(raw.y, 0);
    let w = num(raw.w, 0.2);
    let h = num(raw.h, 0.2);
    if (w < 0) {
      x += w;
      w = -w;
    }
    if (h < 0) {
      y += h;
      h = -h;
    }
    const label = typeof raw.label === 'string' ? raw.label.slice(0, 40) : '';
    return { type: t, label, x: clamp01(x, 0), y: clamp01(y, 0), w: clamp01(w, 0.2), h: clamp01(h, 0.2) };
  }
  if (t === 'arrow') {
    const label = typeof raw.label === 'string' ? raw.label.slice(0, 40) : '';
    return {
      type: 'arrow',
      label,
      x1: clamp01(num(raw.x1, 0.3), 0.3),
      y1: clamp01(num(raw.y1, 0.3), 0.3),
      x2: clamp01(num(raw.x2, 0.6), 0.6),
      y2: clamp01(num(raw.y2, 0.6), 0.6),
    };
  }
  if (t === 'text') {
    const text = typeof raw.text === 'string' ? raw.text.slice(0, 120) : '';
    if (!text) return null;
    return { type: 'text', text, x: clamp01(num(raw.x, 0.05), 0.05), y: clamp01(num(raw.y, 0.05), 0.05) };
  }
  // 兼容旧结构：仅给 x/y/w/h 的当作 box
  if (typeof raw?.x === 'number' && typeof raw?.y === 'number') {
    let x = num(raw.x, 0);
    let y = num(raw.y, 0);
    let w = num(raw.w, 0.2);
    let h = num(raw.h, 0.2);
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    const label = typeof raw.label === 'string' ? raw.label.slice(0, 40) : '';
    return { type: 'box', label, x: clamp01(x, 0), y: clamp01(y, 0), w: clamp01(w, 0.2), h: clamp01(h, 0.2) };
  }
  return null;
}

const ZH_PROMPT = `你是一名「教学文档智能标注助手」。请像老师备课一样分析这张图片，在图上标出关键结构，并给出教学说明。

必须只输出一个 JSON 对象（不要任何解释、不要 markdown 代码块），格式与下面样例完全一致：

{
  "annotations": [
    { "type": "box", "label": "标题栏", "x": 0.12, "y": 0.08, "w": 0.40, "h": 0.12 },
    { "type": "ellipse", "label": "核心按钮", "x": 0.60, "y": 0.45, "w": 0.18, "h": 0.10 },
    { "type": "arrow", "label": "指向数据区", "x1": 0.30, "y1": 0.72, "x2": 0.55, "y2": 0.55 },
    { "type": "text", "text": "此处为用户登录入口", "x": 0.04, "y": 0.30 }
  ],
  "caption": "本图展示了一个后台管理系统的登录与首页布局。",
  "insertHint": "建议插入到「系统使用说明」章节的「界面概览」小节附近。"
}

坐标规则（重要）：
- x/y/w/h 与 x1/y1/x2/y2 均为相对图片宽高的归一化数值，范围 0~1。
- box / ellipse 的 x,y 是区域左上角，w,h 是宽高；若为负值表示向左/上偏移。
- arrow 的 (x1,y1) 是箭头起点，(x2,y2) 是箭头指向的、被说明的位置。
- text 的 x,y 是说明文字气泡的左上角位置。
- 请综合使用多种标注：box 圈出区域、ellipse 高亮重点、arrow 指向并配合 label、text 写独立旁注。
- 标注数量建议 3~8 个，覆盖图片中最值得讲解的元素；label/text 用简体中文、简洁准确。`;

const EN_PROMPT = `You are a "teaching-document annotation assistant". Analyze this image like a teacher preparing a lesson: mark the key structures and give a teaching description.

Output ONLY a JSON object (no explanation, no markdown code fences), matching exactly this sample:

{
  "annotations": [
    { "type": "box", "label": "Title bar", "x": 0.12, "y": 0.08, "w": 0.40, "h": 0.12 },
    { "type": "ellipse", "label": "Core button", "x": 0.60, "y": 0.45, "w": 0.18, "h": 0.10 },
    { "type": "arrow", "label": "Points to data area", "x1": 0.30, "y1": 0.72, "x2": 0.55, "y2": 0.55 },
    { "type": "text", "text": "This is the user login entry", "x": 0.04, "y": 0.30 }
  ],
  "caption": "The image shows the login and home layout of an admin dashboard.",
  "insertHint": "Suggest inserting near the 'Interface Overview' subsection of the 'System Guide' chapter."
}

Coordinate rules:
- x/y/w/h and x1/y1/x2/y2 are normalized (0~1) relative to image width/height.
- For box/ellipse, x,y is top-left, w,h is size; negative means offset left/up.
- For arrow, (x1,y1) is the start, (x2,y2) is the pointed-to location.
- For text, x,y is the top-left of the note bubble.
- Use a mix: box to outline, ellipse to highlight, arrow to point (with label), text for standalone notes.
- Provide 3~8 annotations covering the most instructive elements; keep labels concise.`;

export async function POST(req: NextRequest) {
  try {
    const account = await getRequestAccount(req).catch(() => null);
    if (!account?.id) {
      return NextResponse.json({ code: 'AUTH_REQUIRED', error: '请先登录后使用图片标注。' }, { status: 401 });
    }
    const deepseekApiKey = process.env.DEEPSEEK_API_KEY?.trim();
    if (!deepseekApiKey) {
      return NextResponse.json({ error: 'DEEPSEEK_API_KEY 未配置。' }, { status: 503 });
    }

    const body = await req.json().catch(() => null);
    const image = body?.image;
    const locale = body?.locale === 'en' ? 'en' : 'zh';
    if (
      !image ||
      typeof image.id !== 'string' ||
      typeof image.base64 !== 'string' ||
      !/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(image.base64)
    ) {
      return NextResponse.json({ error: '图片格式无效。' }, { status: 400 });
    }

    const client = new OpenAI({ apiKey: deepseekApiKey, baseURL: 'https://api.deepseek.com' });

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: '你是严谨的标注助手。只输出合法 JSON 对象，不要 markdown 代码块，不要任何多余文字。' },
      {
        role: 'user',
        content: [
          { type: 'text', text: locale === 'zh' ? ZH_PROMPT : EN_PROMPT },
          { type: 'image_url', image_url: { url: image.base64 } },
        ] as unknown as OpenAI.ChatCompletionContentPart[],
      },
    ];

    const annotateOnce = async () =>
      client.chat.completions.create({
        model: DEEPSEEK_MODEL,
        messages,
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 2000,
      });

    // DeepSeek JSON 模式偶发返回空 content，重试一次缓解
    let raw = (await annotateOnce()).choices?.[0]?.message?.content ?? '';
    if (!raw.trim()) raw = (await annotateOnce()).choices?.[0]?.message?.content ?? '';

    let parsed: { annotations?: unknown[]; caption?: unknown; insertHint?: unknown } = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch {
          // ignore
        }
      }
    }

    const annotations: Annotation[] = Array.isArray(parsed.annotations)
      ? parsed.annotations.map(toAnnotation).filter((a): a is Annotation => a !== null)
      : [];

    const caption = typeof parsed.caption === 'string' ? parsed.caption.slice(0, 300) : '';
    const insertHint = typeof parsed.insertHint === 'string' ? parsed.insertHint.slice(0, 300) : '';

    return NextResponse.json({ id: image.id, annotations, caption, insertHint });
  } catch (err) {
    console.error('annotate error', err);
    return NextResponse.json({ error: '图片标注失败。' }, { status: 500 });
  }
}
