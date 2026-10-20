import { NextResponse } from 'next/server';
import { getRequestAccount } from '@/lib/account-auth';
import { getGenerationHistoryDetail, deleteGenerationHistory } from '@/lib/history-db';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  const account = await getRequestAccount(request).catch(() => null);
  if (!account) {
    return NextResponse.json({ error: '请先登录后查看历史记录。 / Please sign in to view history.' }, { status: 401 });
  }
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: '记录 ID 无效。 / Invalid history id.' }, { status: 400 });
  }
  try {
    const item = await getGenerationHistoryDetail(account.id, id);
    if (!item) return NextResponse.json({ error: '记录不存在。 / Not found.' }, { status: 404 });
    return NextResponse.json({ item }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('History detail failed:', error);
    return NextResponse.json({ error: '读取历史记录失败。 / Failed to load history.' }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const account = await getRequestAccount(request).catch(() => null);
  if (!account) {
    return NextResponse.json({ error: '请先登录后操作历史记录。 / Please sign in first.' }, { status: 401 });
  }
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: '记录 ID 无效。 / Invalid history id.' }, { status: 400 });
  }
  try {
    const deleted = await deleteGenerationHistory(account.id, id);
    if (!deleted) return NextResponse.json({ error: '记录不存在。 / Not found.' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('History delete failed:', error);
    return NextResponse.json({ error: '删除历史记录失败。 / Failed to delete history.' }, { status: 500 });
  }
}
