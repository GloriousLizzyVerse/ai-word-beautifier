import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { getRequestAccount } from '@/lib/account-auth';

export const maxDuration = 120;

const DEEPSEEK_MODEL = 'deepseek-flash';

type BoxAnn = { type: 'box'; label?: string; x: number; y: number; w: number; h: number; x2?: number; y2?: number };
type EllipseAnn = { type: 'ellipse'; label?: string; x: number; y: number; w: number; h: number; x2?: number; y2?: number };
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

const MAX_ANNOTATIONS = 2;

// 校验单条标注：数量之外，还要保证"小而准"——过大或贴边的框直接丢弃
function isReasonable(a: Annotation): boolean {
  if (a.type === 'box' || a.type === 'ellipse') {
    // 面积过大（覆盖近半图或整行整列）视为无效
    if (a.w > 0.45 || a.h > 0.45) return false;
    if (a.w < 0.03 || a.h < 0.03) return false;
    return true;
  }
  return true;
}

function toAnnotation(raw: any): Annotation | null {
  const t = raw?.type;
  if (t === 'box' || t === 'ellipse') {
    const x = num(raw.x, NaN);
    const y = num(raw.y, NaN);
    const x2 = num(raw.x2, NaN);
    const y2 = num(raw.y2, NaN);
    const w = num(raw.w, NaN);
    const h = num(raw.h, NaN);
    let xL: number, yT: number, xR: number, yB: number;
    // 优先用四角坐标（左上 + 右下），避免与"中心点"混淆导致偏移
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(x2) && Number.isFinite(y2)) {
      xL = Math.min(x, x2); xR = Math.max(x, x2);
      yT = Math.min(y, y2); yB = Math.max(y, y2);
    } else if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(w) && Number.isFinite(h)) {
      // 兼容旧写法：x,y 为左上角，w,h 为宽高
      xL = Math.min(x, x + w); xR = Math.max(x, x + w);
      yT = Math.min(y, y + h); yB = Math.max(y, y + h);
    } else {
      return null;
    }
    const label = typeof raw.label === 'string' ? raw.label.slice(0, 40) : '';
    return {
      type: t,
      label,
      x: clamp01(xL, 0),
      y: clamp01(yT, 0),
      w: clamp01(xR - xL, 0.2),
      h: clamp01(yB - yT, 0.2),
    };
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
  return null;
}

const ZH_PROMPT = `你是一名「教学文档智能标注助手」。请像老师备课一样分析这张图片，在图上标出关键结构，并给出教学说明。

必须只输出一个 JSON 对象（不要任何解释、不要 markdown 代码块），格式与下面样例完全一致：

{
  "annotations": [
    { "type": "box", "label": "登录按钮", "x": 0.62, "y": 0.40, "x2": 0.78, "y2": 0.48 },
    { "type": "arrow", "label": "密码输入框", "x1": 0.30, "y1": 0.72, "x2": 0.45, "y2": 0.55 }
  ],
  "caption": "本图展示了一个后台管理系统的登录与首页布局。",
  "insertHint": "建议插入到「系统使用说明」章节的「界面概览」小节附近。"
}

坐标规则（非常重要，必须严格遵守）：
- 所有坐标均为相对图片宽高的归一化数值，范围 0~1（绝不要输出像素值）。
- box / ellipse 必须用四角坐标：x,y 是区域【左上角】，x2,y2 是区域【右下角】；绘制时按这四个角定位。
- 严禁用"中心点(cx,cy)"表示位置；也不要用 x,y,w,h（宽高）写法，一律用 x,y,x2,y2。
- arrow 的 (x1,y1) 是箭头起点，(x2,y2) 是箭头指向的、被说明的位置。
- text 的 x,y 是说明文字气泡的左上角位置。
- 数量限制：最多 2 处标注，宁少勿多；只挑选图中最值得讲解的 1~2 个关键元素。
- 尺寸限制：每处标注必须紧贴目标元素本身（紧凑框选），w 和 h 都不得超过 0.35；严禁框住整行、整列、半个画面或整个画面；框边不得贴着图片边缘，区域四边都应与图片边缘保持至少 0.03 的间距。
- label/text 用简体中文、不超过 8 个字、简洁准确。
- 必须紧扣用户在下方给出的「需求/主题」来标注：只标注与需求相关的元素，忽略无关内容；若用户未提供需求，则按通用教学要点标注。`;

const EN_PROMPT = `You are a "teaching-document annotation assistant". Analyze this image like a teacher preparing a lesson: mark the key structures and give a teaching description.

Output ONLY a JSON object (no explanation, no markdown code fences), matching exactly this sample:

{
  "annotations": [
    { "type": "box", "label": "Login button", "x": 0.62, "y": 0.40, "x2": 0.78, "y2": 0.48 },
    { "type": "arrow", "label": "Password field", "x1": 0.30, "y1": 0.72, "x2": 0.45, "y2": 0.55 }
  ],
  "caption": "The image shows the login and home layout of an admin dashboard.",
  "insertHint": "Suggest inserting near the 'Interface Overview' subsection of the 'System Guide' chapter."
}

Coordinate rules:
- All coordinates are normalized (0~1) relative to image width/height. Never output pixel values.
- For box/ellipse use FOUR-CORNER coordinates: x,y is the TOP-LEFT corner, x2,y2 is the BOTTOM-RIGHT corner. Position the shape by these four corners.
- Do NOT use center points (cx,cy); do NOT use x,y,w,h (width/height). Always use x,y,x2,y2.
- For arrow, (x1,y1) is the start, (x2,y2) is the pointed-to location.
- For text, x,y is the top-left of the note bubble.
Quantity limit: at most 2 annotations — fewer is better; pick only the 1~2 most instructive elements.
Size limit: each annotation must tightly fit the target element itself; both w and h must not exceed 0.35; NEVER outline an entire row, column, half or whole image; keep every edge of a region at least 0.03 away from the image borders.
- Use a mix if helpful: box to outline, ellipse to highlight, arrow to point (with label), text for standalone notes.
- Keep labels concise (no more than 8 words).
- Annotate strictly around the user's "requirement/topic" given below: mark only elements related to that need and ignore unrelated ones; if no requirement is given, fall back to general teaching points.`;

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
    const context = typeof body?.context === 'string' ? body.context.slice(0, 1500) : '';
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
          {
            type: 'text',
            text:
              (locale === 'zh' ? ZH_PROMPT : EN_PROMPT) +
              (context
                ? `\n\n用户的需求/主题（请仅标注与之相关的内容）：\n${context}`
                : ''),
          },
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

    const annotations: Annotation[] = (Array.isArray(parsed.annotations)
      ? parsed.annotations.map(toAnnotation).filter((a): a is Annotation => a !== null)
      : []
    )
      .filter(isReasonable)
      .slice(0, MAX_ANNOTATIONS);

    const caption = typeof parsed.caption === 'string' ? parsed.caption.slice(0, 300) : '';
    const insertHint = typeof parsed.insertHint === 'string' ? parsed.insertHint.slice(0, 300) : '';

    return NextResponse.json({ id: image.id, annotations, caption, insertHint });
  } catch (err) {
    console.error('annotate error', err);
    return NextResponse.json({ error: '图片标注失败。' }, { status: 500 });
  }
}
