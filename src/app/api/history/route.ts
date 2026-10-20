import { NextResponse } from 'next/server';
import { getRequestAccount } from '@/lib/account-auth';
import {
  saveGenerationHistory,
  listGenerationHistory,
  deriveHistoryTitle,
  HISTORY_MAX_CONTENT_LENGTH,
  HISTORY_MAX_TITLE_LENGTH,
} from '@/lib/history-db';

export async function GET(request: Request) {
  const account = await getRequestAccount(request).catch(() => null);
  if (!account) {
    return NextResponse.json({ error: '请先登录后查看历史记录。 / Please sign in to view history.' }, { status: 401 });
  }
  try {
    const page = Number(new URL(request.url).searchParams.get('page')) || 1;
    const result = await listGenerationHistory(account.id, page);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('History list failed:', error);
    return NextResponse.json({ error: '读取历史记录失败。 / Failed to load history.' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const account = await getRequestAccount(request).catch(() => null);
  if (!account) {
    return NextResponse.json({ code: 'AUTH_REQUIRED', error: '请先登录后保存历史记录。 / Please sign in first.' }, { status: 401 });
  }
  try {
    const body = await request.json() as { title?: unknown; content?: unknown; locale?: unknown; wordCount?: unknown };
    if (typeof body.content !== 'string' || !body.content.trim()) {
      return NextResponse.json({ error: '内容为空，无法保存。 / Nothing to save.' }, { status: 400 });
    }
    if (body.content.length > HISTORY_MAX_CONTENT_LENGTH) {
      return NextResponse.json({ error: '内容过长，无法保存到历史记录。 / Content too large to save.' }, { status: 413 });
    }
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, HISTORY_MAX_TITLE_LENGTH) : '';
    const id = await saveGenerationHistory({
      userId: account.id,
      title: title || deriveHistoryTitle(body.content),
      content: body.content,
      locale: body.locale === 'en' ? 'en' : 'zh',
      wordCount: typeof body.wordCount === 'number' && Number.isFinite(body.wordCount) ? body.wordCount : 0,
    });
    return NextResponse.json({ ok: true, id });
  } catch (error) {
    console.error('History save failed:', error);
    return NextResponse.json({ error: '保存历史记录失败。 / Failed to save history.' }, { status: 500 });
  }
}
