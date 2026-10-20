'use client';

import { useState, useRef, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Download, Loader2, FileText, Settings, Wand2, AlertCircle, Upload, ImagePlus, X, ChevronDown, ChevronUp, Maximize2, Minimize2, SlidersHorizontal, Copy, Check, History, Trash2, ChevronLeft, ChevronRight, FolderOpen, MessageSquare, PanelRightOpen, PanelRightClose, FileDown, Send, RefreshCw } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import ThemeToggle from '@/components/theme-toggle';
import { useResolvedTheme } from '@/lib/use-theme';
import { isDesktopApp, getDesktopApi, saveDocToWorkspace, folderName, type WorkspaceDoc } from '@/lib/desktop';
import Markdown from 'markdown-to-jsx';
import Link from 'next/link';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type Locale = 'en' | 'zh';

type HistoryItem = {
  id: string;
  title: string;
  snippet: string;
  wordCount: number;
  createdAt: string;
};

const LOCALE_STORAGE_KEY = '__app_locale__';
const PENDING_GENERATION_DRAFT_KEY = '__pending_generation_draft__';

function resolveInitialLocale(): Locale {
  if (typeof window === 'undefined') return 'en';
  const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  if (saved === 'en' || saved === 'zh') return saved;
  const browserLang = (navigator.language || '').toLowerCase();
  return browserLang.startsWith('zh') ? 'zh' : 'en';
}

const MODEL = 'deepseek-flash';

const MAX_IMAGE_COUNT = 8;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const TYPEWRITER_INTERVAL_MS = 28;
const MAX_TYPEWRITER_CHARS_PER_TICK = 3;

function getClipboardImageFiles(clipboardData: DataTransfer | null): File[] {
  if (!clipboardData) return [];

  // Browsers may expose the same pasted image through both `items` and
  // `files`. Prefer `items` when available so one paste produces one upload.
  const itemFiles = Array.from(clipboardData.items)
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));

  if (itemFiles.length > 0) return itemFiles;

  return Array.from(clipboardData.files).filter((file) => file.type.startsWith('image/'));
}

const WRITING_STYLES = [
  { value: '', label: '默认风格' },
  { value: '正式专业', label: '正式专业' },
  { value: '学术严谨', label: '学术严谨' },
  { value: '轻松通俗', label: '轻松通俗' },
  { value: '文艺抒情', label: '文艺抒情' },
  { value: '幽默风趣', label: '幽默风趣' },
  { value: '平实自然', label: '平实自然' },
];

const EDU_LEVELS = [
  { value: '', label: '不限水平' },
  { value: '研究生', label: '研究生' },
  { value: '大学生', label: '大学生' },
  { value: '高中生', label: '高中生' },
  { value: '初中生', label: '初中生' },
  { value: '小学生', label: '小学生' },
];

const PERF_LEVELS = [
  { value: '优秀', label: '优秀' },
  { value: '中等', label: '中等' },
  { value: '差劲', label: '差劲' },
];

const DIAGRAM_MODES = [
  { value: 'none', label: '不生成图示' },
  { value: 'auto', label: '智能自动插入' },
];

let mammothPromise: Promise<typeof import('mammoth/mammoth.browser')> | null = null;
const CHUNK_RELOAD_GUARD_KEY = '__chunk_reload_once__';

function AccountControls({ locale, email, onLogout }: { locale: 'zh' | 'en'; email: string; onLogout: () => void }) {
  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    onLogout();
  }

  return email ? (
    <div className="flex items-center gap-2 text-xs sm:text-sm">
      <span className="max-w-20 truncate text-xs text-gray-600 dark:text-gray-400 sm:max-w-48 sm:text-sm">{email}</span>
      <button type="button" onClick={logout} className="rounded-md border border-gray-200 dark:border-gray-700 px-2 py-1.5 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800">
        {locale === 'zh' ? '退出' : 'Log out'}
      </button>
    </div>
  ) : (
    <Link href="/login" className="rounded-md border border-indigo-200 dark:border-indigo-800 px-2.5 py-1.5 text-xs font-medium text-indigo-700 dark:text-indigo-300 hover:bg-indigo-50 dark:hover:bg-indigo-800/50 sm:px-3 sm:text-sm">
      {locale === 'zh' ? '登录 / 注册' : 'Sign in'}
    </Link>
  );
}

type MermaidRenderer = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, text: string) => Promise<{ svg: string }>;
};

let mermaidLoaderPromise: Promise<MermaidRenderer> | null = null;

function loadMermaid(): Promise<MermaidRenderer> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Mermaid 仅可在浏览器中使用'));
  }
  if (mermaidLoaderPromise) {
    return mermaidLoaderPromise;
  }
  mermaidLoaderPromise = import('mermaid')
    .then((module) => {
      const mermaid = (module.default || module) as unknown as MermaidRenderer;
      if (!mermaid?.initialize || !mermaid?.render) {
        throw new Error('Mermaid 模块不可用');
      }
      return mermaid;
    });
  return mermaidLoaderPromise;
}

/** Clean up common Mermaid syntax issues from AI-generated content */
function sanitizeMermaidCode(raw: string): string {
  let code = raw.trim();
  // Remove leading/trailing whitespace
  code = code.replace(/^\s+|\s+$/g, '');
  // Fix common issue: unquoted Chinese/special-char node labels
  // e.g. A[开始] -> A["开始"], A(处理数据) -> A("处理数据")
  code = code.replace(/(\w+)\[([^\]"'\n]*[\u4e00-\u9fff][^\]"'\n]*)\]/g, '$1["$2"]');
  code = code.replace(/(\w+)\(([^\)"'\n]*[\u4e00-\u9fff][^\)"'\n]*)\)/g, '$1("$2")');
  code = code.replace(/(\w+)\{([^\}"'\n]*[\u4e00-\u9fff][^\}"'\n]*)\}/g, '$1{"$2"}');
  code = code.replace(/(\w+)\(\(([^\)"'\n]*[\u4e00-\u9fff][^\)"'\n]*)\)\)/g, '(("$2"))');
  // Fix curly quotes → straight quotes
  code = code.replace(/[""]/g, '"').replace(/['']/g, "'");
  // Remove invisible characters
  code = code.replace(/[\u200b\u200c\u200d\ufeff]/g, '');
  return code;
}

function MermaidDiagram({ code }: { code: string }) {
  // Mermaid bakes colours into the SVG it emits, so it has to be re-rendered
  // when the theme flips. The .docx export path deliberately stays light.
  const theme = useResolvedTheme();

  const [locale] = useState<Locale>(() => resolveInitialLocale());
  const [svg, setSvg] = useState('');
  const [renderError, setRenderError] = useState('');
  const chartCode = sanitizeMermaidCode(code);

  useEffect(() => {
    if (!chartCode) return;
    let active = true;
    const renderMermaid = async () => {
      try {
        const mermaid = await loadMermaid();
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: theme === 'dark' ? 'dark' : 'default',
          flowchart: {
            htmlLabels: false,
            useMaxWidth: false,
          },
        });
        const renderId = `mermaid-${crypto.randomUUID()}`;
        const { svg: renderedSvg } = await mermaid.render(renderId, chartCode);
        if (!active) return;
        setSvg(renderedSvg);
        setRenderError('');
      } catch {
        if (!active) return;
        setSvg('');
        setRenderError(locale === 'zh' ? '图示渲染失败，已跳过该图示。' : 'Diagram rendering failed, skipped.');
      }
    };
    renderMermaid();
    return () => {
      active = false;
    };
  }, [chartCode, locale, theme]);

  if (!chartCode) {
    return null;
  }

  if (renderError) {
    return null; // 静默跳过渲染失败的图示
  }
  if (!svg) {
    return <div className="my-3 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-3 py-2 text-xs text-gray-500 dark:text-gray-400">{locale === 'zh' ? '图示渲染中...' : 'Rendering diagram...'}</div>;
  }
  return <div className="mermaid-diagram my-3 overflow-x-auto rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-2" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function getMammoth() {
  if (!mammothPromise) {
    mammothPromise = import('mammoth/mammoth.browser');
  }
  return mammothPromise;
}

export default function Home() {
  const router = useRouter();
  const pathname = usePathname();
  const [locale, setLocale] = useState<Locale>('en');
  const [accountEmail, setAccountEmail] = useState('');
  const [accountStatusLoaded, setAccountStatusLoaded] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [content, setContent] = useState('');
  const model = MODEL;
  const [isFetching, setIsFetching] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const isTypingRef = useRef(false);
  const fullTextRef = useRef('');
  const [statusMsg, setStatusMsg] = useState('');

  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requiresLogin, setRequiresLogin] = useState(false);
  const [success, setSuccess] = useState(false);
  const [displayedMarkdown, setDisplayedMarkdown] = useState('');
  const [isDownloading, setIsDownloading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isPrivacyModalOpen, setIsPrivacyModalOpen] = useState(false);
  const [isAgreementModalOpen, setIsAgreementModalOpen] = useState(false);
  const [isCopied, setIsCopied] = useState(false);

  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [historyConfirm, setHistoryConfirm] = useState<{ type: 'restore' | 'delete'; id: string; title: string } | null>(null);
  const [isOffline, setIsOffline] = useState(false);

  // Desktop-client only features (working directory + agent chat)
  const [isDesktopClient, setIsDesktopClient] = useState(false);
  const [workingDir, setWorkingDir] = useState('');
  const [appMode, setAppMode] = useState<'doc' | 'agent'>('doc');
  const [agentInput, setAgentInput] = useState('');
  const [agentMessages, setAgentMessages] = useState<{ role: 'user' | 'assistant'; content: string; savedPath?: string }[]>([]);
  const [showAgentPreview, setShowAgentPreview] = useState(false);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceDoc[]>([]);
  const [desktopNotice, setDesktopNotice] = useState('');

  useEffect(() => {
    setIsDesktopClient(isDesktopApp());
  }, []);

  useEffect(() => {
    const updateOnlineStatus = () => setIsOffline(!navigator.onLine);
    updateOnlineStatus();
    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
    return () => {
      window.removeEventListener('online', updateOnlineStatus);
      window.removeEventListener('offline', updateOnlineStatus);
    };
  }, []);

  useEffect(() => {
    setLocale(resolveInitialLocale());
  }, []);

  useEffect(() => {
    let active = true;
    setAccountStatusLoaded(false);
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((response) => response.ok ? response.json() as Promise<{ user: { email: string } | null }> : null)
      .then((result) => { if (active) setAccountEmail(result?.user?.email || ''); })
      .catch(() => { if (active) setAccountEmail(''); })
      .finally(() => { if (active) setAccountStatusLoaded(true); });
    return () => { active = false; };
  }, [pathname]);

  const copyText = async (value: string) => {
    if (typeof window === 'undefined') return false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch {}

    try {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.top = '-9999px';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      const ok = document.execCommand('copy');
      textarea.blur();
      document.body.removeChild(textarea);
      return ok;
    } catch {
      return false;
    }
  };

  const handleCopy = async () => {
    try {
      const ok = await copyText(copyFriendlyMarkdown);
      if (!ok) throw new Error('copy_failed');
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text:', err);
    }
  };

  const HISTORY_PAGE_SIZE = 10;

  const countContentWords = (value: string) => value.replace(/\s/g, '').length;

  const saveHistoryEntry = async (markdown: string) => {
    if (!markdown.trim()) return;
    try {
      await fetch('/api/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: extractTitleFromMarkdown(markdown),
          content: markdown,
          locale,
          wordCount: countContentWords(markdown),
        }),
      });
    } catch {
      // 历史保存失败不影响生成结果
    }
  };

  const loadHistory = async (page: number) => {
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const response = await fetch(`/api/history?page=${page}`, { cache: 'no-store' });
      const data = await response.json() as { items?: HistoryItem[]; total?: number; page?: number; error?: string };
      if (!response.ok) throw new Error(data.error || 'load_failed');
      setHistoryItems(data.items || []);
      setHistoryTotal(data.total || 0);
      setHistoryPage(data.page || page);
    } catch {
      setHistoryError(locale === 'zh' ? '历史记录加载失败，请重试。' : 'Failed to load history. Please retry.');
    } finally {
      setHistoryLoading(false);
    }
  };

  const openHistory = () => {
    setIsHistoryOpen(true);
    void loadHistory(1);
  };

  const handleDeleteHistory = async (id: string) => {
    try {
      const response = await fetch(`/api/history/${id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('delete_failed');
      setHistoryConfirm(null);
      const remaining = historyItems.length - 1;
      const nextPage = remaining === 0 && historyPage > 1 ? historyPage - 1 : historyPage;
      await loadHistory(nextPage);
    } catch {
      setHistoryError(locale === 'zh' ? '删除失败，请重试。' : 'Failed to delete. Please retry.');
    }
  };

  const handleRestoreHistory = async (id: string) => {
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const response = await fetch(`/api/history/${id}`, { cache: 'no-store' });
      const data = await response.json() as { item?: { content?: string }; error?: string };
      if (!response.ok || typeof data.item?.content !== 'string') throw new Error(data.error || 'load_failed');
      fullTextRef.current = data.item.content;
      setDisplayedMarkdown(data.item.content);
      setError(null);
      setHistoryConfirm(null);
      setIsHistoryOpen(false);
    } catch {
      setHistoryError(locale === 'zh' ? '恢复失败，请重试。' : 'Failed to restore. Please retry.');
    } finally {
      setHistoryLoading(false);
    }
  };

  const resultRef = useRef<HTMLDivElement>(null);
  const modalResultRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const agentImageRef = useRef<HTMLInputElement>(null);
  const [isContentOpen, setIsContentOpen] = useState(false);
  const [wordCount, setWordCount] = useState('');
  const [writingStyle, setWritingStyle] = useState('');
  const [eduLevel, setEduLevel] = useState('');
  const [perfLevel, setPerfLevel] = useState('优秀');
  const [addTypos, setAddTypos] = useState(false);
  const [humanTrace, setHumanTrace] = useState(false);
  const [enableEvidenceSupport, setEnableEvidenceSupport] = useState(false);
  const [enableSignatureDate, setEnableSignatureDate] = useState(false);
  const [authorName, setAuthorName] = useState('');
  const [documentDate, setDocumentDate] = useState('');
  const [refinePrompt, setRefinePrompt] = useState('');
  const [diagramMode, setDiagramMode] = useState('none');

  useEffect(() => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  }, [locale]);

  const text = (key: string) => {
    const en: Record<string, string> = {
      appTitle: 'AI Document Formatter',
      navFormatter: 'Formatter',
      diffTitle: 'Not just "generate a doc"',
      diffSubtitle: 'Compare typical AI chat output vs. a Word-ready document you can download and share.',
      diffToggleShow: 'Show comparison',
      diffToggleHide: 'Hide',
      diffLeftTitle: 'Typical AI output',
      diffRightTitle: 'AI Word output',
      diffLeftP1: 'Plain text / Markdown that still needs manual formatting.',
      diffRightP1: 'Structured, polished content that exports to .docx.',
      diffLeftB1: 'Hard to copy into Word cleanly',
      diffLeftB2: 'No image insertion (only descriptions)',
      diffLeftB3: 'No consistent headings / spacing',
      diffRightB1: 'One-click .docx download',
      diffRightB2: 'Upload images and insert into the document',
      diffRightB3: 'Templates + headings + lists by default',
      generationSettings: 'Generation Settings',
      promptLabel: 'Instructions',
      promptPlaceholder: 'Example: Write a project proposal. Keep it professional and well-structured with headings, lists, and a conclusion.',
      contentCardTitle: 'Source Content (Optional)',
      contentFilled: 'Added',
      contentHint: 'Paste text or upload a .docx to beautify an existing document.',
      advancedTitle: 'Advanced Settings',
      wordCountLabel: 'Target word count (Optional)',
      writingStyleLabel: 'Writing style (Optional)',
      eduLevelLabel: 'Audience level (Optional)',
      perfLevelLabel: 'Writing level',
      addTyposLabel: 'Add random typos',
      addTyposHint: 'Adds 1-5 random typos to mimic human writing.',
      humanTraceLabel: 'Human-like thinking traces',
      humanTraceHint: 'Adds natural self-corrections and comparisons for a more human tone.',
      evidenceLabel: 'Evidence support',
      evidenceHint: 'Adds verifiable references (URLs, papers, articles) where appropriate.',
      diagramLabel: 'Diagrams',
      diagramHint: 'AI chooses the number, type, and placement of diagrams based on the document, then inserts them into the content.',
      signatureTitle: 'Signature & Date',
      signatureToggle: 'Enable signature & date',
      authorLabel: 'Author (Optional)',
      authorPlaceholder: "Leave empty to use 'XXX'",
      dateLabel: 'Date (Optional)',
      datePlaceholder: 'Leave empty to use today',
      signatureOffHint: 'Disabled: the generated content will not include signature or date.',
      generateButton: 'Generate',
      refineButton: 'Refine',
      refinePlaceholder: 'Describe what to modify based on the current content.',
      downloadButton: 'Download .docx',
      generatingDefault: 'Generating...',
      analyzingText: 'Analyzing...',
      analyzingImages: 'Analyzing images...',
      generatingText: 'Generating...',
      refineAnalyzing: 'Reviewing current content...',
      refineGenerating: 'Refining...',
      generateSuccess: 'Success. Your Word document download has started.',
      agreement: 'Terms',
      privacy: 'Privacy',
      agreementBrackets: 'Terms',
      privacyBrackets: 'Privacy Policy',
      errorNeedPrompt: 'Please enter instructions.',
      errorUploadDocxOnly: 'Only .docx files are supported.',
      errorReadDocx: 'Failed to read document: ',
      errorDownload: 'Download failed.',
      errorUnknown: 'Something went wrong.',
      errorNetwork: 'Network error. Please check your connection and try again.',
      errorTimeout: 'The request timed out. Please simplify the prompt and try again.',
      errorAuth: 'API key is invalid or missing. Please contact the site administrator.',
      errorRateLimit: 'Too many requests. Please try again later.',
      errorQuota: 'Service quota exceeded. Please try again later.',
      privacyTitle: 'Privacy Policy',
      agreementTitle: 'Terms of Service',
      footerBrand: 'AI Document Formatter',
    };

    const zh: Record<string, string> = {
      appTitle: 'AI Word 排版美化助手',
      navFormatter: '排版美化',
      diffTitle: '不只是"生成一篇文档"',
      diffSubtitle: '用对比法展示差异：传统 AI 输出 vs 可直接下载的 Word 成品。',
      diffToggleShow: '查看对比',
      diffToggleHide: '收起',
      diffLeftTitle: '传统 AI 输出',
      diffRightTitle: 'AI Word 输出',
      diffLeftP1: '多为纯文本/Markdown，需要你手动排版成 Word。',
      diffRightP1: '自动结构化排版，一键导出 .docx 并可直接分享。',
      diffLeftB1: '复制到 Word 容易乱格式',
      diffLeftB2: '图片只能"描述"，不能直接插入',
      diffLeftB3: '标题层级与段落间距不一致',
      diffRightB1: '一键下载 .docx',
      diffRightB2: '上传图片并插入到文档',
      diffRightB3: '模板 + 标题 + 列表默认到位',
      generationSettings: '生成设置',
      promptLabel: '排版/生成要求',
      promptPlaceholder: '例如：请帮我写一份关于 AI 技术在医疗领域应用的商业计划书，要求排版专业，包含标题、正文、列表和总结...',
      contentCardTitle: '原始内容 (可选)',
      contentFilled: '已填写',
      contentHint: '如需美化已有文档，请展开粘贴文本或上传',
      advancedTitle: '高级参数设置',
      wordCountLabel: '指定字数 (可选)',
      writingStyleLabel: '文笔风格 (可选)',
      eduLevelLabel: '写作水平角色 (可选)',
      perfLevelLabel: '水平等级',
      addTyposLabel: '添加随机错别字',
      addTyposHint: '开启后文章中将随机出现1-5个错别字',
      humanTraceLabel: '真人思考痕迹',
      humanTraceHint: '开启后会增加自然推敲、对比与自我修正语气，模拟真人写作过程',
      evidenceLabel: '数据与案例支撑',
      evidenceHint: '开启后会在合适段落插入可核验的来源引用（网址、论文或文章）',
      diagramLabel: '自动图示插入',
      diagramHint: '由 AI 根据文档内容与篇幅决定图示数量、类型及插入位置，并直接插入正文。',
      signatureTitle: '署名与日期',
      signatureToggle: '启用署名与日期',
      authorLabel: '文档署名 / 报告者 (可选)',
      authorPlaceholder: "不填写则用 'XXX' 代替",
      dateLabel: '落款日期 (可选)',
      datePlaceholder: '不填则自动获取今日日期',
      signatureOffHint: '已关闭：生成内容中将不包含署名与落款日期，涉及时间时仅允许基于已提供资料。',
      generateButton: '生成',
      refineButton: '润色',
      refinePlaceholder: '输入后期优化/修改要求...',
      downloadButton: '下载 Word',
      generatingDefault: '正在生成内容...',
      analyzingText: '正在分析需求...',
      analyzingImages: '正在分析图片...',
      generatingText: '正在生成内容...',
      refineAnalyzing: '正在阅读当前内容并构思优化方案...',
      refineGenerating: '正在润色生成中...',
      generateSuccess: '生成成功！Word文档已开始下载。',
      agreement: '用户协议',
      privacy: '隐私政策',
      agreementBrackets: '《用户协议》',
      privacyBrackets: '《隐私政策》',
      errorNeedPrompt: '请输入排版或生成要求',
      errorUploadDocxOnly: '仅支持 .docx 格式的 Word 文档',
      errorReadDocx: '读取文档失败：',
      errorDownload: '下载失败',
      errorUnknown: '发生未知错误',
      errorNetwork: '网络连接异常，请检查您的网络设置后重试。',
      errorTimeout: '响应超时，请尝试精简要求或稍后再试。',
      errorAuth: 'API 密钥无效或未配置，请联系运营者检查后台 API 密钥。',
      errorRateLimit: '当前访问人数过多，请稍后重试。',
      errorQuota: '服务额度不足，请稍后再试。',
      privacyTitle: '隐私政策',
      agreementTitle: '用户协议',
      footerBrand: 'AI Word 排版美化助手',
    };

    const dict = locale === 'zh' ? zh : en;
    return dict[key] || key;
  };

  const writingStyleOptions = locale === 'zh'
    ? WRITING_STYLES
    : [
      { value: '', label: 'Default' },
      { value: 'Formal', label: 'Formal' },
      { value: 'Academic', label: 'Academic' },
      { value: 'Plain', label: 'Plain' },
      { value: 'Narrative', label: 'Narrative' },
      { value: 'Humorous', label: 'Humorous' },
      { value: 'Natural', label: 'Natural' },
    ];

  const eduLevelOptions = locale === 'zh'
    ? EDU_LEVELS
    : [
      { value: '', label: 'Any' },
      { value: 'Graduate', label: 'Graduate' },
      { value: 'College', label: 'College' },
      { value: 'High school', label: 'High school' },
      { value: 'Middle school', label: 'Middle school' },
      { value: 'Elementary', label: 'Elementary' },
    ];

  const perfLevelOptions = locale === 'zh'
    ? PERF_LEVELS
    : [
      { value: 'Excellent', label: 'Excellent' },
      { value: 'Average', label: 'Average' },
      { value: 'Poor', label: 'Poor' },
    ];

  const agentActive = isDesktopClient && appMode === 'agent' && Boolean(workingDir);

  const diagramModeOptions = locale === 'zh'
    ? DIAGRAM_MODES
    : [
      { value: 'none', label: 'None' },
      { value: 'auto', label: 'Smart auto-insert' },
    ];

  const cleanMarkdown = displayedMarkdown
    .replace(/^```(markdown|html)?\n?/i, '')
    .replace(/\n?```$/i, '')
    .replace(/^html\s*\n/i, '');

  const copyFriendlyMarkdown = cleanMarkdown
    .replace(/<div\s+align=["']center["']>\s*<h1[^>]*>([\s\S]*?)<\/h1>\s*<\/div>/gi, (_, title: string) => `# ${title.replace(/<[^>]+>/g, '').trim()}`)
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, title: string) => `# ${title.replace(/<[^>]+>/g, '').trim()}`);

  useEffect(() => {
    const didReload = sessionStorage.getItem(CHUNK_RELOAD_GUARD_KEY) === '1';
    if (didReload) {
      sessionStorage.removeItem(CHUNK_RELOAD_GUARD_KEY);
    }
    const maybeRecoverChunkError = (raw: unknown) => {
      if (didReload) return;
      const message = typeof raw === 'string' ? raw : raw instanceof Error ? raw.message : '';
      const isChunkError = message.includes('ChunkLoadError') || message.includes('Failed to load chunk') || message.includes('/_next/static/chunks/');
      if (!isChunkError) return;
      sessionStorage.setItem(CHUNK_RELOAD_GUARD_KEY, '1');
      const url = new URL(window.location.href);
      url.searchParams.set('_r', Date.now().toString());
      window.location.replace(url.toString());
    };
    const onError = (event: ErrorEvent) => maybeRecoverChunkError(event.message || event.error);
    const onUnhandledRejection = (event: PromiseRejectionEvent) => maybeRecoverChunkError(event.reason);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }, []);

  useEffect(() => {
    fetch('/api/admin/visit', {
      method: 'POST',
      keepalive: true,
    }).catch(() => {});
  }, []);

  const extractTitleFromMarkdown = (markdown: string) => {
    const lines = (markdown || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    for (const line of lines) {
      const htmlH1Match = line.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      if (htmlH1Match) {
        const title = htmlH1Match[1]
          .replace(/<[^>]+>/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (title) return title;
      }
      const mdH1Match = line.match(/^#\s+(.+)$/);
      if (mdH1Match) {
        const title = mdH1Match[1].replace(/\s+/g, ' ').trim();
        if (title) return title;
      }
    }
    return 'AI排版美化文档';
  };

  const sanitizeFileName = (name: string) => {
    const sanitized = (name || 'AI排版美化文档')
      .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '')
      .replace(/\.+$/g, '')
      .trim();
    return (sanitized || 'AI排版美化文档').slice(0, 80);
  };

  const getFileNameFromDisposition = (contentDisposition: string | null) => {
    if (!contentDisposition) return null;
    const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match?.[1]) {
      try {
        return decodeURIComponent(utf8Match[1]);
      } catch {
        return utf8Match[1];
      }
    }
    const quotedMatch = contentDisposition.match(/filename="([^"]+)"/i);
    if (quotedMatch?.[1]) return quotedMatch[1];
    const plainMatch = contentDisposition.match(/filename=([^;]+)/i);
    if (plainMatch?.[1]) return plainMatch[1].trim();
    return null;
  };

  // Auto scroll to bottom of result when generating or typing
  useEffect(() => {
    if ((isFetching || isTyping) && autoScroll) {
      // Scroll the small preview box
      if (resultRef.current) {
        resultRef.current.scrollTop = resultRef.current.scrollHeight;
      }
      // Scroll the modal preview box
      if (modalResultRef.current) {
        modalResultRef.current.scrollTop = modalResultRef.current.scrollHeight;
      }
      // If modal is open and uses window scroll instead, we need to scroll window
      // But modalResultRef is set on the scrollable container inside the modal.
    }
  }, [displayedMarkdown, isFetching, isTyping, autoScroll]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement;
    // Check if user scrolled up
    // Allow a 50px threshold for bottom detection
    const isAtBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 50;
    setAutoScroll(isAtBottom);
  };

  // Render a small, steady amount of text each tick. A proportional catch-up
  // step makes large network chunks appear as paragraph-sized jumps.
  useEffect(() => {
    const intervalId = setInterval(() => {
      setDisplayedMarkdown(prev => {
        const full = fullTextRef.current;
        if (prev.length < full.length) {
          if (!isTypingRef.current) {
            isTypingRef.current = true;
            setIsTyping(true);
          }
          const diff = full.length - prev.length;
          const step = Math.min(MAX_TYPEWRITER_CHARS_PER_TICK, diff);
          return full.slice(0, prev.length + step);
        } else {
          if (isTypingRef.current) {
            isTypingRef.current = false;
            setIsTyping(false);
          }
          return prev;
        }
      });
    }, TYPEWRITER_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, []);

  type AnnotShape =
    | { type: 'box'; label?: string; x: number; y: number; w: number; h: number }
    | { type: 'ellipse'; label?: string; x: number; y: number; w: number; h: number }
    | { type: 'arrow'; label?: string; x1: number; y1: number; x2: number; y2: number }
    | { type: 'text'; text: string; x: number; y: number };

  const [uploadedImages, setUploadedImages] = useState<{
    id: string;
    base64: string;
    origBase64: string;
    file: File;
    annotated?: boolean;
    annotationCount?: number;
    caption?: string;
    insertHint?: string;
    variant?: number;
  }[]>([]);
  const [teachingDocMode, setTeachingDocMode] = useState(false);
  const [annotatingIds, setAnnotatingIds] = useState<string[]>([]);

  useEffect(() => {
    if (pathname !== '/') return;
    try {
      const savedDraft = window.sessionStorage.getItem(PENDING_GENERATION_DRAFT_KEY);
      if (!savedDraft) return;
      const draft = JSON.parse(savedDraft) as {
        prompt?: unknown; content?: unknown; locale?: unknown; wordCount?: unknown; writingStyle?: unknown;
        eduLevel?: unknown; perfLevel?: unknown; addTypos?: unknown; humanTrace?: unknown;
        enableEvidenceSupport?: unknown; diagramMode?: unknown; enableSignatureDate?: unknown;
        authorName?: unknown; documentDate?: unknown; refinePrompt?: unknown; hadImages?: unknown;
      };
      if (typeof draft.prompt === 'string') setPrompt(draft.prompt);
      if (typeof draft.content === 'string') setContent(draft.content);
      if (draft.locale === 'zh' || draft.locale === 'en') setLocale(draft.locale);
      if (typeof draft.wordCount === 'string') setWordCount(draft.wordCount);
      if (typeof draft.writingStyle === 'string') setWritingStyle(draft.writingStyle);
      if (typeof draft.eduLevel === 'string') setEduLevel(draft.eduLevel);
      if (draft.perfLevel === '优秀' || draft.perfLevel === '中等' || draft.perfLevel === '差劲') setPerfLevel(draft.perfLevel);
      if (typeof draft.addTypos === 'boolean') setAddTypos(draft.addTypos);
      if (typeof draft.humanTrace === 'boolean') setHumanTrace(draft.humanTrace);
      if (typeof draft.enableEvidenceSupport === 'boolean') setEnableEvidenceSupport(draft.enableEvidenceSupport);
      if (draft.diagramMode === 'none' || draft.diagramMode === 'auto' || draft.diagramMode === 'mindmap' || draft.diagramMode === 'flowchart') setDiagramMode(draft.diagramMode === 'none' ? 'none' : 'auto');
      if (typeof draft.enableSignatureDate === 'boolean') setEnableSignatureDate(draft.enableSignatureDate);
      if (typeof draft.authorName === 'string') setAuthorName(draft.authorName);
      if (typeof draft.documentDate === 'string') setDocumentDate(draft.documentDate);
      if (typeof draft.refinePrompt === 'string') setRefinePrompt(draft.refinePrompt);
      if (draft.hadImages) setError(draft.locale === 'zh' ? '生成要求和设置已恢复；为保护图片隐私，请登录后重新添加图片。' : 'Your request and settings were restored. Please re-add images after signing in.');
      window.sessionStorage.removeItem(PENDING_GENERATION_DRAFT_KEY);
    } catch (restoreError) {
      console.error('Unable to restore pending generation draft:', restoreError);
      window.sessionStorage.removeItem(PENDING_GENERATION_DRAFT_KEY);
    }
  }, [pathname]);

  const readFileAsDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (event) => resolve((event.target?.result as string) || '');
      reader.onerror = () => reject(new Error('图片读取失败'));
      reader.readAsDataURL(file);
    });

  const savePendingGenerationDraft = (refinementInstruction = refinePrompt) => {
    try {
      window.sessionStorage.setItem(PENDING_GENERATION_DRAFT_KEY, JSON.stringify({
        prompt, content, locale, wordCount, writingStyle, eduLevel, perfLevel, addTypos, humanTrace,
        enableEvidenceSupport, diagramMode, enableSignatureDate, authorName, documentDate, refinePrompt: refinementInstruction,
        hadImages: uploadedImages.length > 0,
      }));
      return true;
    } catch (saveError) {
      console.error('Unable to save pending generation draft:', saveError);
      return false;
    }
  };

  const convertGifToPngDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const img = new Image();
      const objectUrl = URL.createObjectURL(file);
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          URL.revokeObjectURL(objectUrl);
          reject(new Error('图片处理失败'));
          return;
        }
        ctx.drawImage(img, 0, 0);
        const pngDataUrl = canvas.toDataURL('image/png');
        URL.revokeObjectURL(objectUrl);
        resolve(pngDataUrl);
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error('GIF 解析失败'));
      };
      img.src = objectUrl;
    });

  const drawAnnotations = (base64: string, annotations: AnnotShape[]): Promise<string> =>
    new Promise((resolve, reject) => {
      // 兜底：最多 2 处，丢弃过大（近半图/整行整列）或超长的标注
      const anns = annotations
        .filter((a) => {
          if (a.type === 'box' || a.type === 'ellipse') return a.w <= 0.5 && a.h <= 0.5;
          if (a.type === 'arrow') return Math.hypot(a.x2 - a.x1, a.y2 - a.y1) <= 0.9;
          return true;
        })
        .slice(0, 2);
      const img = new Image();
      img.onload = () => {
        const natW = img.naturalWidth || img.width;
        const natH = img.naturalHeight || img.height;
        // 控制输出尺寸，避免 docx 内嵌超大图
        const scale = Math.min(1, 1600 / Math.max(natW, natH));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(natW * scale));
        canvas.height = Math.max(1, Math.round(natH * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('annotate ctx'));
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const W = canvas.width;
        const H = canvas.height;
        const fontPx = Math.max(14, Math.round(W / 38));
        const lineW = Math.max(2, Math.round(W / 240));
        ctx.lineWidth = lineW;
        ctx.font = `600 ${fontPx}px sans-serif`;
        ctx.textBaseline = 'middle';

        const COLORS = {
          box: 'rgba(220,38,38,1)', // 红
          ellipse: 'rgba(22,163,74,1)', // 绿
          arrow: 'rgba(37,99,235,1)', // 蓝
          textBg: 'rgba(15,23,42,0.88)', // 深色气泡
          textFg: '#ffffff',
        } as const;

        const drawLabelChip = (text: string, lx: number, ly: number, color: string) => {
          if (!text) return;
          const padX = fontPx * 0.35;
          const lh = fontPx + padX;
          const tw = ctx.measureText(text).width;
          let bx = lx;
          let by = ly;
          if (by < 0) by = 0;
          if (bx + tw + padX * 2 > W) bx = Math.max(0, W - tw - padX * 2);
          ctx.fillStyle = color;
          ctx.beginPath();
          const r = 4;
          const bw = tw + padX * 2;
          ctx.roundRect(bx, by, bw, lh, r);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.fillText(text, bx + padX, by + lh / 2);
        };

        const wrapText = (text: string, maxChars: number): string[] => {
          const lines: string[] = [];
          let cur = '';
          for (const ch of text) {
            cur += ch;
            if (cur.length >= maxChars) {
              lines.push(cur);
              cur = '';
            }
          }
          if (cur) lines.push(cur);
          return lines.slice(0, 6);
        };

        const chipH = fontPx + fontPx * 0.35;
        anns.forEach((a, i) => {
          if (a.type === 'box') {
            // 钳制在画布内，避免贴边/出界
            const rx = Math.max(2, Math.min(a.x * W, W - 4));
            const ry = Math.max(2, Math.min(a.y * H, H - 4));
            const rw = Math.max(4, Math.min(a.w * W, W - rx - 2));
            const rh = Math.max(4, Math.min(a.h * H, H - ry - 2));
            ctx.fillStyle = 'rgba(220,38,38,0.10)';
            ctx.fillRect(rx, ry, rw, rh);
            ctx.strokeStyle = COLORS.box;
            ctx.strokeRect(rx, ry, rw, rh);
            // 标签优先放框上方；框太靠上则放框内左上角，避免压到图片顶端
            drawLabelChip(a.label || `区域 ${i + 1}`, rx, ry >= chipH + 4 ? ry - chipH - 2 : ry + 4, COLORS.box);
          } else if (a.type === 'ellipse') {
            const rxRaw = Math.max(2, Math.min(a.x * W, W - 4));
            const ryRaw = Math.max(2, Math.min(a.y * H, H - 4));
            const rw = Math.max(4, Math.min(a.w * W, W - rxRaw - 2));
            const rh = Math.max(4, Math.min(a.h * H, H - ryRaw - 2));
            const cx = rxRaw + rw / 2;
            const cy = ryRaw + rh / 2;
            const rx = rw / 2;
            const ry = rh / 2;
            ctx.fillStyle = 'rgba(22,163,74,0.10)';
            ctx.beginPath();
            ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = COLORS.ellipse;
            ctx.beginPath();
            ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
            ctx.stroke();
            drawLabelChip(a.label || `重点 ${i + 1}`, rxRaw, ryRaw >= chipH + 4 ? ryRaw - chipH - 2 : ryRaw + 4, COLORS.ellipse);
          } else if (a.type === 'arrow') {
            const x1 = a.x1 * W;
            const y1 = a.y1 * H;
            const x2 = a.x2 * W;
            const y2 = a.y2 * H;
            ctx.strokeStyle = COLORS.arrow;
            ctx.fillStyle = COLORS.arrow;
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
            const angle = Math.atan2(y2 - y1, x2 - x1);
            const head = fontPx * 0.9;
            ctx.beginPath();
            ctx.moveTo(x2, y2);
            ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 7), y2 - head * Math.sin(angle - Math.PI / 7));
            ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 7), y2 - head * Math.sin(angle + Math.PI / 7));
            ctx.closePath();
            ctx.fill();
            if (a.label) {
              const mx = (x1 + x2) / 2;
              const my = (y1 + y2) / 2;
              drawLabelChip(a.label, mx, my - (fontPx + fontPx * 0.35), COLORS.arrow);
            }
          } else if (a.type === 'text') {
            const lines = wrapText(a.text, 18);
            const padX = fontPx * 0.35;
            const lh = fontPx + padX;
            const lineH = fontPx * 1.15;
            let maxW = 0;
            lines.forEach((ln) => {
              maxW = Math.max(maxW, ctx.measureText(ln).width);
            });
            const bw = maxW + padX * 2;
            const bh = lines.length * lineH + padX;
            let bx = a.x * W;
            let by = a.y * H;
            if (by < 0) by = 0;
            if (bx + bw > W) bx = Math.max(0, W - bw);
            if (by + bh > H) by = Math.max(0, H - bh);
            ctx.fillStyle = COLORS.textBg;
            ctx.beginPath();
            ctx.roundRect(bx, by, bw, bh, 6);
            ctx.fill();
            ctx.fillStyle = COLORS.textFg;
            lines.forEach((ln, idx) => {
              ctx.fillText(ln, bx + padX, by + padX + lineH * idx + lineH / 2 - padX / 2);
            });
          }
        });
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('annotate load'));
      img.src = base64;
    });

  // 把用户当前的「排版生成要求」(原始内容 + 指令) 拼成标注上下文
  const buildAnnotContext = () => [content, prompt].filter(Boolean).join('\n').slice(0, 1000);

  // 标注某张原图：带上需求上下文，绘制后写回；返回标注后的 base64（失败返回 undefined）
  const runAnnotation = async (id: string, base64: string, context?: string): Promise<string | undefined> => {
    setAnnotatingIds(prev => Array.from(new Set([...prev, id])));
    try {
      const res = await fetch('/api/annotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ image: { id, base64 }, locale, context: context || '' }),
      });
      if (res.ok) {
        const data = await res.json();
        const annotations: AnnotShape[] = (Array.isArray(data.annotations) ? data.annotations : []).slice(0, 2);
        const patch: {
          annotated: boolean;
          base64?: string;
          annotationCount: number;
          caption: string;
          insertHint: string;
        } = {
          annotated: true,
          annotationCount: annotations.length,
          caption: typeof data.caption === 'string' ? data.caption : '',
          insertHint: typeof data.insertHint === 'string' ? data.insertHint : '',
        };
        if (annotations.length) {
          patch.base64 = await drawAnnotations(base64, annotations);
        }
        setUploadedImages(prev => prev.map(im => (im.id === id ? { ...im, ...patch } : im)));
        return annotations.length ? patch.base64 : undefined;
      } else if (res.status === 401) {
        setError(locale === 'zh' ? '请先登录后使用图片标注。' : 'Sign in to use image annotation.');
      }
    } catch {
      // 标注失败则保留原图
    } finally {
      setAnnotatingIds(prev => prev.filter(x => x !== id));
    }
    return undefined;
  };

  // 一图多用：基于同一张原图再生成一份新的标注副本（不覆盖已有副本）
  const handleReannotate = (img: { id: string; base64: string; origBase64: string; file: File }, context?: string) => {
    if (uploadedImages.length >= MAX_IMAGE_COUNT) {
      setError(locale === 'zh' ? `最多上传 ${MAX_IMAGE_COUNT} 张图片。` : `You can upload up to ${MAX_IMAGE_COUNT} images.`);
      return;
    }
    const src = img.origBase64 || img.base64;
    const newId = `img_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    setUploadedImages(prev => {
      const maxVariant = prev
        .filter(p => p.file === img.file)
        .reduce((m, p) => Math.max(m, p.variant || 1), 1);
      return [...prev, { id: newId, base64: src, origBase64: src, file: img.file, variant: maxVariant + 1 }];
    });
    runAnnotation(newId, src);
  };

  const handleImageFiles = async (files: File[]) => {
    if (!files.length) return;

    setError(null);

    if (uploadedImages.length + files.length > MAX_IMAGE_COUNT) {
      setError(locale === 'zh' ? `最多上传 ${MAX_IMAGE_COUNT} 张图片。` : `You can upload up to ${MAX_IMAGE_COUNT} images.`);
      return;
    }

    for (const file of files) {
      try {
        if (!file.type.startsWith('image/')) {
          throw new Error('图片格式无效');
        }
        if (file.size > MAX_IMAGE_SIZE) {
          throw new Error('图片不能超过 10MB');
        }
        const base64 = file.type === 'image/gif'
          ? await convertGifToPngDataUrl(file)
          : await readFileAsDataUrl(file);
        const id = `img_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        // 仅存原图，不立即标注——等用户输入需求后，点「标注」或生成时再按需求上下文标注
        setUploadedImages(prev => [...prev, { id, base64, origBase64: base64, file, variant: 1, annotated: false }]);
      } catch {
        setError(locale === 'zh' ? `图片处理失败：${file.name}` : `Failed to process image: ${file.name}`);
      }
    }

    if (imageInputRef.current) {
      imageInputRef.current.value = '';
    }
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    await handleImageFiles(Array.from(e.target.files || []));
  };

  const handleImagePaste = async (e: React.ClipboardEvent<HTMLElement>) => {
    const files = getClipboardImageFiles(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    await handleImageFiles(files);
  };

  const imageFilesHandlerRef = useRef<(files: File[]) => void>(() => undefined);
  imageFilesHandlerRef.current = handleImageFiles;

  useEffect(() => {
    const handleDocumentPaste = (event: ClipboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;

      const files = getClipboardImageFiles(event.clipboardData);
      if (!files.length) return;

      event.preventDefault();
      void imageFilesHandlerRef.current(files);
    };

    document.addEventListener('paste', handleDocumentPaste);
    return () => document.removeEventListener('paste', handleDocumentPaste);
  }, []);

  const removeImage = (idToRemove: string) => {
    setUploadedImages(prev => prev.filter(img => img.id !== idToRemove));
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.docx')) {
      setError(text('errorUploadDocxOnly'));
      return;
    }

    setIsUploading(true);
    setError(null);
    try {
      const arrayBuffer = await file.arrayBuffer();
      const mammoth = await getMammoth();
      const result = await mammoth.extractRawText({ arrayBuffer });
      setContent(result.value);
      if (result.messages.length > 0) {
        console.warn('Mammoth messages:', result.messages);
      }
    } catch (err) {
      const e = err as Error;
      setError(text('errorReadDocx') + e.message);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const executeGenerate = async (payload: Record<string, unknown>, initialMsg: string, typingMsg: string) => {
    setIsFetching(true);
    setError(null);
    setRequiresLogin(false);
    setSuccess(false);
    setAutoScroll(true);
    fullTextRef.current = '';
    setDisplayedMarkdown('');
    setStatusMsg(initialMsg);

    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as { error?: string; code?: string };
        if (errorData.code === 'AUTH_REQUIRED') {
          setRequiresLogin(true);
          if (savePendingGenerationDraft()) router.push('/login?returnTo=%2F');
          else setError(locale === 'zh' ? '无法暂存当前内容，请复制保存后再登录。' : 'Unable to save your draft. Please copy it before signing in.');
          throw new Error('AUTH_REQUIRED');
        }
        throw new Error(errorData.error || (locale === 'zh' ? '生成失败，请检查网络或重试' : 'Request failed. Please try again.'));
      }

      if (!response.body) throw new Error('ReadableStream not supported');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let firstTokenReceived = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (!firstTokenReceived) {
          firstTokenReceived = true;
          setStatusMsg(typingMsg);
        }

        const chunk = decoder.decode(value, { stream: true });
        fullTextRef.current += chunk;
      }

      const trailingText = decoder.decode();
      if (trailingText) {
        fullTextRef.current += trailingText;
      }

      // 生成完成后自动保存到历史记录（失败不影响生成结果）
      const finalText = fullTextRef.current;
      if (finalText.trim()) {
        void saveHistoryEntry(finalText);
        // 桌面端且已选择工作目录时，直接在工作目录生成 .docx
        if (isDesktopClient && workingDir) {
          void saveCurrentDocToWorkspace(undefined, finalText);
        }
      }

    } catch (err) {
      console.error('Generation Error:', err);
      const e = err as Error;

      // Friendly error messages mapping
      let errorMsg = e.message === 'AUTH_REQUIRED'
        ? (locale === 'zh' ? '请先登录账号，再使用文档生成服务。' : 'Please sign in before using document generation.')
        : e.message || text('errorUnknown');
      if (errorMsg.includes('Failed to fetch') || errorMsg.includes('NetworkError')) {
        errorMsg = text('errorNetwork');
      } else if (errorMsg.includes('timeout') || errorMsg.includes('Timeout')) {
        errorMsg = text('errorTimeout');
      } else if (errorMsg.includes('ReadableStream not supported')) {
        errorMsg = locale === 'zh'
          ? '您的浏览器版本过低，不支持流式生成，请升级浏览器。'
          : 'Your browser does not support streaming responses. Please upgrade your browser.';
      } else if (errorMsg.includes('balance') || errorMsg.includes('insufficient_quota') || errorMsg.includes('arrears') || errorMsg.includes('1004')) {
        errorMsg = text('errorQuota');
      } else if (errorMsg.includes('rate_limit') || errorMsg.includes('429') || errorMsg.includes('Too Many Requests')) {
        errorMsg = text('errorRateLimit');
      } else if (errorMsg.includes('401') || errorMsg.includes('Invalid Authentication') || errorMsg.includes('Unauthorized')) {
        errorMsg = text('errorAuth');
      }

      setError(errorMsg);
    } finally {
      setIsFetching(false);
      setStatusMsg('');
    }
  };

  const handleGenerate = async () => {
    // Original formatter mode
    if (!prompt.trim()) {
      setError(text('errorNeedPrompt'));
      return;
    }

    if (!accountStatusLoaded) return;
    if (!accountEmail) {
      if (!savePendingGenerationDraft()) {
        setError(locale === 'zh' ? '无法暂存当前内容，请复制保存后再登录。' : 'Unable to save your draft. Please copy it before signing in.');
        return;
      }
      router.push('/login?returnTo=%2F');
      return;
    }

    // 教学模式下，先按用户需求上下文把尚未标注的图片标注好，再生成文档
    const resolvedBase64 = new Map<string, string>();
    if (teachingDocMode) {
      const ctx = buildAnnotContext();
      const pending = uploadedImages.filter(im => im.origBase64 && !im.annotated);
      if (pending.length) {
        await Promise.all(
          pending.map(async (im) => {
            const ab = await runAnnotation(im.id, im.origBase64, ctx);
            if (ab) resolvedBase64.set(im.id, ab);
          })
        );
      }
    }

    const payload = {
      prompt,
      content,
      model,
      locale,
      wordCount,
      writingStyle,
      eduLevel,
      perfLevel,
      addTypos,
      humanTrace,
      enableEvidenceSupport,
      diagramMode,
      enableSignatureDate,
      authorName,
      documentDate,
      images: uploadedImages.map(img => ({
        id: img.id,
        base64: resolvedBase64.get(img.id) || img.base64,
        caption: img.caption || '',
        insertHint: img.insertHint || '',
      })),
    };

    await executeGenerate(
      payload,
      uploadedImages.length > 0 ? text('analyzingImages') : text('analyzingText'),
      text('generatingText')
    );
  };

  const handleAgentSend = async () => {
    const instruction = agentInput.trim();
    if (!instruction || isFetching || isTyping) return;
    if (!accountStatusLoaded) return;
    if (!accountEmail) {
      setError(locale === 'zh' ? '请先登录账号，再使用对话生成。' : 'Please sign in first.');
      return;
    }

    // 教学模式下，先按对话需求上下文给未标注的图片标注好，再发送
    const resolvedBase64 = new Map<string, string>();
    if (teachingDocMode) {
      const ctx = [content, instruction].filter(Boolean).join('\n').slice(0, 1000);
      const pending = uploadedImages.filter(im => im.origBase64 && !im.annotated);
      if (pending.length) {
        await Promise.all(
          pending.map(async (im) => {
            const ab = await runAnnotation(im.id, im.origBase64, ctx);
            if (ab) resolvedBase64.set(im.id, ab);
          })
        );
      }
    }

    setAgentMessages(prev => [...prev, { role: 'user', content: instruction }]);
    setAgentInput('');

    const payload = {
      prompt: instruction,
      content,
      model,
      locale,
      wordCount,
      writingStyle,
      eduLevel,
      perfLevel,
      addTypos,
      humanTrace,
      enableEvidenceSupport,
      diagramMode,
      enableSignatureDate,
      authorName,
      documentDate,
      images: uploadedImages.map(img => ({
        id: img.id,
        base64: resolvedBase64.get(img.id) || img.base64,
        caption: img.caption || '',
        insertHint: img.insertHint || '',
      })),
    };

    await executeGenerate(payload, text('analyzingText'), text('generatingText'));

    const result = fullTextRef.current;
    if (!result.trim()) return;
    const saved = isDesktopClient && workingDir
      ? await saveCurrentDocToWorkspace(undefined, result)
      : { ok: false, path: undefined };
    setAgentMessages(prev => [...prev, {
      role: 'assistant',
      content: result,
      savedPath: saved.ok ? saved.path : undefined,
    }]);
  };

  const handleRefine = async (customPrompt?: string) => {
    const instruction = customPrompt || refinePrompt;
    if (!instruction.trim()) return;
    if (!accountStatusLoaded) return;
    if (!accountEmail) {
      if (!savePendingGenerationDraft(instruction)) {
        setError(locale === 'zh' ? '无法暂存当前内容，请复制保存后再登录。' : 'Unable to save your draft. Please copy it before signing in.');
        return;
      }
      router.push('/login?returnTo=%2F');
      return;
    }

    const payload = {
      prompt: locale === 'zh'
        ? "【后期优化/修改要求】：\n" + instruction + "\n\n请严格基于下方提供的【当前已有内容】进行修改和润色，不要偏离原意，保持原文未要求修改的部分基本不变。"
        : "Refinement request:\n" + instruction + "\n\nPlease revise and improve the content strictly based on the current draft below. Keep the original meaning and avoid unnecessary changes.",
      content: cleanMarkdown, // Use currently generated content as the new base context
      model,
      locale,
      wordCount,
      writingStyle,
      eduLevel,
      perfLevel,
      addTypos,
      humanTrace,
      enableEvidenceSupport,
      diagramMode,
      enableSignatureDate,
      authorName,
      documentDate,
      images: uploadedImages.map(img => ({ id: img.id, base64: img.base64, caption: img.caption || '', insertHint: img.insertHint || '' })),
    };

    setRefinePrompt('');
    await executeGenerate(
      payload,
      text('refineAnalyzing'),
      text('refineGenerating')
    );
  };

  const escapeHtml = (value: string) => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const normalizeSignatureBlockForDownload = (markdown: string) => {
    if (!enableSignatureDate) return markdown;
    if (/<div\s+align=["']right["']>/i.test(markdown)) return markdown;
    const lines = markdown.split(/\r?\n/);
    let dateLineIndex = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i].trim()) {
        dateLineIndex = i;
        break;
      }
    }
    if (dateLineIndex <= 0) return markdown;
    const dateLine = lines[dateLineIndex].trim();
    if (!/^\d{4}年\d{1,2}月\d{1,2}日$/.test(dateLine)) return markdown;
    let authorLineIndex = dateLineIndex - 1;
    while (authorLineIndex >= 0 && !lines[authorLineIndex].trim()) {
      authorLineIndex -= 1;
    }
    if (authorLineIndex < 0) return markdown;
    const authorLine = lines[authorLineIndex].trim();
    if (!authorLine || authorLine.length > 30 || /[。！？.!?]$/.test(authorLine)) return markdown;
    const replacement = [
      '<div align="right">',
      `<p class="signature-line">${escapeHtml(authorLine)}</p>`,
      `<p class="signature-line">${escapeHtml(dateLine)}</p>`,
      '</div>'
    ].join('\n');
    return [
      ...lines.slice(0, authorLineIndex),
      replacement,
      ...lines.slice(dateLineIndex + 1)
    ].join('\n');
  };

  const normalizeSvgForCanvas = (svgContent: string) => {
    const parser = new DOMParser();
    const svgDoc = parser.parseFromString(svgContent, 'image/svg+xml');
    const svgEl = svgDoc.documentElement;
    const ns = 'http://www.w3.org/2000/svg';
    const decodeHtmlText = (value: string) => {
      const htmlDoc = parser.parseFromString(`<body>${value}</body>`, 'text/html');
      return htmlDoc.body.textContent || '';
    };
    const charUnits = (char: string) => (/[\u0000-\u00ff]/.test(char) ? 0.56 : 1);
    const wrapByUnits = (line: string, maxUnits: number) => {
      const parts: string[] = [];
      let current = '';
      let units = 0;
      Array.from(line).forEach((char) => {
        const nextUnits = units + charUnits(char);
        if (current && nextUnits > maxUnits) {
          parts.push(current);
          current = char;
          units = charUnits(char);
        } else {
          current += char;
          units = nextUnits;
        }
      });
      if (current) parts.push(current);
      return parts;
    };
    const foreignObjects = Array.from(svgEl.querySelectorAll('foreignObject'));
    foreignObjects.forEach((fo) => {
      const rawXml = Array.from(fo.childNodes).map((node) => new XMLSerializer().serializeToString(node)).join('');
      const plainText = decodeHtmlText(
        rawXml
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/gi, ' ')
      );
      const x = Number.parseFloat(fo.getAttribute('x') || '0');
      const y = Number.parseFloat(fo.getAttribute('y') || '0');
      const width = Number.parseFloat(fo.getAttribute('width') || '0');
      const height = Number.parseFloat(fo.getAttribute('height') || '0');
      const maxUnits = Math.max(4, Math.floor((width - 16) / 8.4));
      const normalizedLines = plainText
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .flatMap((line) => wrapByUnits(line, maxUnits));
      if (normalizedLines.length === 0) {
        fo.remove();
        return;
      }
      const lines = normalizedLines;
      const centerX = x + width / 2;
      const centerY = y + height / 2;
      const lineHeight = 18;
      const startY = centerY - ((lines.length - 1) * lineHeight) / 2;
      const textNode = svgDoc.createElementNS(ns, 'text');
      textNode.setAttribute('x', String(centerX));
      textNode.setAttribute('y', String(startY));
      textNode.setAttribute('text-anchor', 'middle');
      textNode.setAttribute('fill', '#111111');
      textNode.setAttribute('font-size', '14');
      textNode.setAttribute('font-family', 'Microsoft YaHei, PingFang SC, Arial, sans-serif');
      lines.forEach((line, idx) => {
        const tspan = svgDoc.createElementNS(ns, 'tspan');
        tspan.setAttribute('x', String(centerX));
        if (idx > 0) {
          tspan.setAttribute('dy', String(lineHeight));
        }
        tspan.textContent = line;
        textNode.appendChild(tspan);
      });
      fo.replaceWith(textNode);
    });
    const rootWidthAttr = Number((svgEl.getAttribute('width') || '').replace(/[^\d.]/g, ''));
    const rootHeightAttr = Number((svgEl.getAttribute('height') || '').replace(/[^\d.]/g, ''));
    const rootViewBox = svgEl.getAttribute('viewBox')?.trim().split(/\s+/).map(Number) || [];
    const padding = 24;
    if (rootViewBox.length === 4 && rootViewBox.every((num) => Number.isFinite(num))) {
      const [vbX, vbY, vbW, vbH] = rootViewBox;
      svgEl.setAttribute('viewBox', `${vbX - padding} ${vbY - padding} ${vbW + padding * 2} ${vbH + padding * 2}`);
    }
    if (Number.isFinite(rootWidthAttr) && rootWidthAttr > 0) {
      svgEl.setAttribute('width', String(rootWidthAttr + padding * 2));
    }
    if (Number.isFinite(rootHeightAttr) && rootHeightAttr > 0) {
      svgEl.setAttribute('height', String(rootHeightAttr + padding * 2));
    }
    svgEl.querySelectorAll('text,tspan').forEach((node) => {
      const element = node as SVGElement;
      if (!element.getAttribute('fill') || element.getAttribute('fill') === 'currentColor') {
        element.setAttribute('fill', '#111111');
      }
      if (!element.getAttribute('font-family')) {
        element.setAttribute('font-family', 'Microsoft YaHei, PingFang SC, Arial, sans-serif');
      }
    });
    return new XMLSerializer().serializeToString(svgDoc);
  };

  const svgToPngDataUrl = async (svgContent: string) => {
    const normalizedSvg = normalizeSvgForCanvas(svgContent);
    const parser = new DOMParser();
    const svgDoc = parser.parseFromString(normalizedSvg, 'image/svg+xml');
    const svgEl = svgDoc.documentElement;
    const viewBox = svgEl.getAttribute('viewBox')?.trim().split(/\s+/).map(Number) || [];
    const widthAttr = Number((svgEl.getAttribute('width') || '').replace(/[^\d.]/g, ''));
    const heightAttr = Number((svgEl.getAttribute('height') || '').replace(/[^\d.]/g, ''));
    const width = Number.isFinite(widthAttr) && widthAttr > 0 ? widthAttr : (viewBox[2] || 1200);
    const height = Number.isFinite(heightAttr) && heightAttr > 0 ? heightAttr : (viewBox[3] || 800);
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(width * scale));
    canvas.height = Math.max(1, Math.ceil(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('图示转换失败');
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const { Canvg } = await import('canvg');
    const canvg = Canvg.fromString(ctx, normalizedSvg, { ignoreAnimation: true, ignoreMouse: true });
    await canvg.render();
    return canvas.toDataURL('image/png');
  };

  const convertMermaidBlocksToImages = async (markdown: string) => {
    const codeBlockRegex = /```[ \t]*([^\n`]*)\n([\s\S]*?)```/g;
    if (!codeBlockRegex.test(markdown)) return markdown;
    const mermaid = await loadMermaid();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      flowchart: {
        htmlLabels: false,
        useMaxWidth: false,
      },
    });
    codeBlockRegex.lastIndex = 0;
    let result = '';
    let lastIndex = 0;
    let blockNo = 1;
    while (true) {
      const match = codeBlockRegex.exec(markdown);
      if (!match) break;
      result += markdown.slice(lastIndex, match.index);
      const lang = (match[1] || '').trim().toLowerCase();
      const rawBody = match[2] || '';
      let graphCode = '';
      if (lang === 'mermaid') {
        graphCode = rawBody.trim();
      } else if (!lang && /^mermaid\s*\n/i.test(rawBody)) {
        graphCode = rawBody.replace(/^mermaid\s*\n/i, '').trim();
      }
      if (!graphCode) {
        result += match[0];
      } else {
        const cleanedCode = sanitizeMermaidCode(graphCode);
        const renderCode = `%%{init: {'securityLevel': 'strict', 'theme': 'default', 'flowchart': {'htmlLabels': false, 'useMaxWidth': false}}}%%\n${cleanedCode}`;
        const { svg } = await mermaid.render(`mermaid-download-${crypto.randomUUID()}-${blockNo}`, renderCode);
        if (/class="error-icon"|class="error-text"|Syntax error in text/i.test(svg)) {
          result += match[0]; // Keep original code block if render fails
          lastIndex = codeBlockRegex.lastIndex;
          blockNo += 1;
          continue;
        }
        const pngDataUrl = await svgToPngDataUrl(svg);
        result += `![流程图${blockNo}](${pngDataUrl})`;
      }
      lastIndex = codeBlockRegex.lastIndex;
      blockNo += 1;
    }
    result += markdown.slice(lastIndex);
    return result;
  };

  const refreshWorkspace = async (dir: string) => {
    const api = getDesktopApi();
    if (!api || !dir) { setWorkspaceFiles([]); return; }
    try {
      setWorkspaceFiles(await api.listDocs(dir));
    } catch {
      setWorkspaceFiles([]);
    }
  };

  const handlePickWorkingDir = async () => {
    const api = getDesktopApi();
    if (!api) return;
    const dir = await api.pickFolder();
    if (!dir) return;
    setWorkingDir(dir);
    setDesktopNotice('');
    await refreshWorkspace(dir);
  };

  const handlePickLocalFile = async () => {
    const api = getDesktopApi();
    if (!api) return;
    setError(null);
    const picked = await api.pickFile();
    if (!picked) return;
    try {
      setIsUploading(true);
      if (/\.(docx?)$/i.test(picked.ext)) {
        const mammoth = await getMammoth();
        const result = await mammoth.extractRawText({ arrayBuffer: picked.bytes?.buffer ?? new ArrayBuffer(0) });
        setContent(result.value);
      } else {
        setContent(picked.text || '');
      }
      setIsContentOpen(true);
    } catch (err) {
      const e = err as Error;
      setError(text('errorReadDocx') + e.message);
    } finally {
      setIsUploading(false);
    }
  };

  const handleOpenWorkspaceFile = async (name: string) => {
    const api = getDesktopApi();
    if (!api || !workingDir) return;
    await api.showInFolder(`${workingDir}\\${name}`);
  };

  /** Saves the currently generated document straight into the desktop working directory. */
  const saveCurrentDocToWorkspace = async (explicitName?: string, markdownOverride?: string) => {
    if (!isDesktopClient || !workingDir) return { ok: false as const, path: undefined as string | undefined, error: 'no_workspace' };
    try {
      const { blob, fileName } = await requestDocx(markdownOverride);
      const result = await saveDocToWorkspace(workingDir, explicitName || fileName, blob);
      if (result.ok) {
        setDesktopNotice(locale === 'zh' ? `已保存到工作目录：${result.path?.split(/[\\/]/).pop() || fileName}` : `Saved to workspace: ${result.path?.split(/[\\/]/).pop() || fileName}`);
        await refreshWorkspace(workingDir);
      } else {
        setDesktopNotice(locale === 'zh' ? `保存失败：${result.error || '未知错误'}` : `Save failed: ${result.error || 'unknown error'}`);
      }
      return { ok: Boolean(result.ok), path: result.path, error: result.error };
    } catch (err) {
      const e = err as Error;
      if (e.message !== 'AUTH_REQUIRED') {
        setDesktopNotice(locale === 'zh' ? '保存失败，请检查网络后重试。' : 'Save failed. Please retry.');
      }
      return { ok: false, path: undefined, error: e.message };
    }
  };

  const requestDocx = async (markdownOverride?: string): Promise<{ blob: Blob; fileName: string }> => {
    const sourceMarkdown = markdownOverride || cleanMarkdown;
    if (!sourceMarkdown) throw new Error(text('errorDownload'));
    let markdownForDownload = normalizeSignatureBlockForDownload(sourceMarkdown);
    markdownForDownload = await convertMermaidBlocksToImages(markdownForDownload);
    const response = await fetch('/api/download', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        markdown: markdownForDownload,
        images: uploadedImages.map(img => ({ id: img.id, base64: img.base64 }))
      }),
    });

    if (!response.ok) {
      if (response.status === 401) {
        const errorData = await response.json().catch(() => ({})) as { code?: string };
        if (errorData.code === 'AUTH_REQUIRED') {
          setRequiresLogin(true);
          throw new Error('AUTH_REQUIRED');
        }
      }
      throw new Error(text('errorDownload'));
    }

    const blob = await response.blob();
    const serverFileName = getFileNameFromDisposition(response.headers.get('content-disposition'));
    const fallbackFileName = `${sanitizeFileName(extractTitleFromMarkdown(markdownForDownload))}.docx`;
    const finalFileName = sanitizeFileName((serverFileName || fallbackFileName).replace(/\.docx$/i, '')) + '.docx';
    return { blob, fileName: finalFileName };
  };

  const downloadDocxToBrowser = async ({ blob, fileName }: { blob: Blob; fileName: string }) => {
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  };

  const handleDownload = async () => {
    if (!cleanMarkdown) return;
    setIsDownloading(true);
    setError(null);
    setRequiresLogin(false);

    try {
      const docx = await requestDocx();
      if (isDesktopClient && workingDir) {
        await saveCurrentDocToWorkspace(docx.fileName);
      } else {
        await downloadDocxToBrowser(docx);
      }
      setSuccess(true);
    } catch (err) {
      console.error('Download Error:', err);
      const e = err as Error;

      let errorMsg = e.message === 'AUTH_REQUIRED'
        ? (locale === 'zh' ? '请先登录账号，再下载文档。' : 'Please sign in before downloading documents.')
        : e.message || '下载发生未知错误';
      if (errorMsg.includes('Failed to fetch') || errorMsg.includes('NetworkError')) {
        errorMsg = '下载中断，请检查您的网络连接并重试。';
      }

      setError(errorMsg);
    } finally {
      setIsDownloading(false);
    }
  };

  const createMarkdownOverrides = (imageClassName: string) => {
    // Mermaid changes from source code to an SVG with a different height.
    // Keep it stable while the typewriter is still receiving text, then render
    // it once after the full response is available.
    const isStreamingPreview = isFetching || isTyping;
    return {
      img: {
      component: ({ alt, src, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => {
        let resolvedSrc = src;
        const matchedImg = uploadedImages.find(img => img.id === src);
        if (matchedImg) {
          resolvedSrc = matchedImg.base64;
        }
        const ImgElement = 'img';
        return (
          <ImgElement
            alt={alt}
            src={resolvedSrc}
            className={cn("rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 object-contain mx-auto", imageClassName)}
            {...props}
          />
        );
      }
    },
    pre: {
      component: ({ children, ...props }: React.HTMLAttributes<HTMLPreElement>) => {
        const firstChild = Array.isArray(children) ? children[0] : children;
        if (firstChild && typeof firstChild === 'object' && 'props' in firstChild) {
          const codeNode = firstChild as React.ReactElement<{ className?: string; children?: React.ReactNode }>;
          const className = codeNode.props.className || '';
          const codeContent = Array.isArray(codeNode.props.children)
            ? codeNode.props.children.join('')
            : String(codeNode.props.children ?? '');
          if (className.includes('language-mermaid')) {
            return isStreamingPreview
              ? <div className="my-3 min-h-16 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-3 py-3 text-xs text-gray-500 dark:text-gray-400">{locale === 'zh' ? '图示生成中…' : 'Generating diagram…'}</div>
              : <MermaidDiagram code={codeContent} />;
          }
          if (/^mermaid\s*\n/i.test(codeContent)) {
            return isStreamingPreview
              ? <div className="my-3 min-h-16 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-3 py-3 text-xs text-gray-500 dark:text-gray-400">{locale === 'zh' ? '图示生成中…' : 'Generating diagram…'}</div>
              : <MermaidDiagram code={codeContent.replace(/^mermaid\s*\n/i, '')} />;
          }
        }
        return <pre {...props}>{children}</pre>;
      }
      }
    };
  };

  return (
    <div className="min-h-screen lg:h-screen bg-gray-50/50 dark:bg-gray-950 flex flex-col lg:overflow-hidden">
      {/* Header */}
      <header className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 shrink-0 z-10">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 text-indigo-600 dark:text-indigo-400 min-w-0">
            <Wand2 className="w-5 h-5 shrink-0 sm:w-6 sm:h-6" />
            <h1 className="text-base font-bold text-gray-900 dark:text-gray-100 whitespace-nowrap truncate sm:text-xl">{text('appTitle')}</h1>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            {isDesktopClient && (
              <>
                <button
                  type="button"
                  onClick={handlePickWorkingDir}
                  title={workingDir || (locale === 'zh' ? '选择工作目录' : 'Choose working folder')}
                  className="flex items-center gap-1.5 rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs sm:text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors max-w-[220px]"
                >
                  <FolderOpen className="w-4 h-4 shrink-0" />
                  <span className="truncate">
                    {workingDir ? folderName(workingDir) : (locale === 'zh' ? '选择工作目录' : 'Workspace')}
                  </span>
                </button>
                {workingDir && (
                  <div className="hidden md:flex rounded-lg bg-gray-100 dark:bg-gray-800 p-1">
                    <button
                      type="button"
                      onClick={() => setAppMode('doc')}
                      className={cn(
                        'px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1',
                        appMode === 'doc' ? 'bg-white dark:bg-gray-700 text-indigo-700 dark:text-indigo-300 shadow-sm' : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
                      )}
                    >
                      <FileText className="w-3.5 h-3.5" />
                      {locale === 'zh' ? '文档' : 'Doc'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setAppMode('agent')}
                      className={cn(
                        'px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1',
                        appMode === 'agent' ? 'bg-white dark:bg-gray-700 text-indigo-700 dark:text-indigo-300 shadow-sm' : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
                      )}
                    >
                      <MessageSquare className="w-3.5 h-3.5" />
                      {locale === 'zh' ? '对话' : 'Chat'}
                    </button>
                  </div>
                )}
              </>
            )}
            <AccountControls locale={locale} email={accountEmail} onLogout={() => setAccountEmail('')} />
            {accountEmail && (
              <button
                type="button"
                onClick={openHistory}
                title={locale === 'zh' ? '查看历史生成记录' : 'View generation history'}
                className="flex items-center gap-1.5 rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs sm:text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                <History className="w-4 h-4" />
                <span className="hidden sm:inline">{locale === 'zh' ? '历史' : 'History'}</span>
              </button>
            )}
            <ThemeToggle locale={locale} />
            <div className="hidden md:flex rounded-lg bg-gray-100 dark:bg-gray-800 p-1">
              <button
                type="button"
                onClick={() => setLocale('en')}
                className={cn(
                  'px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
                  locale === 'en' ? 'bg-white dark:bg-gray-700 text-indigo-700 dark:text-indigo-300 shadow-sm' : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
                )}
              >
                EN
              </button>
              <button
                type="button"
                onClick={() => setLocale('zh')}
                className={cn(
                  'px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
                  locale === 'zh' ? 'bg-white dark:bg-gray-700 text-indigo-700 dark:text-indigo-300 shadow-sm' : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
                )}
              >
                中文
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 lg:min-h-0 lg:overflow-hidden">
        <div className="max-w-7xl mx-auto px-4 py-6 lg:h-full flex flex-col gap-4">
          {isOffline && (
            <div className="shrink-0 flex items-start sm:items-center gap-2 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 px-4 py-2.5 text-xs sm:text-sm text-amber-800 dark:text-amber-300">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 sm:mt-0" />
              <span>
                {locale === 'zh'
                  ? '当前处于离线状态：AI 生成、下载 .docx、历史记录、账号登录等需要联网的功能暂不可用，网络恢复后自动恢复使用。'
                  : 'You are offline: AI generation, .docx download, history, and sign-in are unavailable until you reconnect.'}
              </span>
            </div>
          )}
          <div className="shrink-0">
            <div className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-sm p-5">
              <details className="group">
                <summary className="list-none cursor-pointer select-none">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-base md:text-lg font-semibold text-gray-900 dark:text-gray-100">{text('diffTitle')}</div>
                      <div className="mt-1 text-sm text-gray-600 dark:text-gray-400">{text('diffSubtitle')}</div>
                    </div>
                    <div className="shrink-0 inline-flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-3 py-2 text-sm font-medium text-gray-800 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
                      <span className="group-open:hidden">{text('diffToggleShow')}</span>
                      <span className="hidden group-open:inline">{text('diffToggleHide')}</span>
                      <ChevronDown className="w-4 h-4 text-gray-500 dark:text-gray-400 group-open:hidden" />
                      <ChevronUp className="w-4 h-4 text-gray-500 dark:text-gray-400 hidden group-open:block" />
                    </div>
                  </div>
                </summary>
                <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-4">
                    <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">{text('diffLeftTitle')}</div>
                    <div className="mt-1 text-xs text-gray-600 dark:text-gray-400">{text('diffLeftP1')}</div>
                    <ul className="mt-3 space-y-2 text-sm text-gray-700 dark:text-gray-300">
                      <li className="flex gap-2"><span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-gray-400 dark:bg-gray-600 shrink-0" />{text('diffLeftB1')}</li>
                      <li className="flex gap-2"><span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-gray-400 dark:bg-gray-600 shrink-0" />{text('diffLeftB2')}</li>
                      <li className="flex gap-2"><span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-gray-400 dark:bg-gray-600 shrink-0" />{text('diffLeftB3')}</li>
                    </ul>
                  </div>
                  <div className="rounded-xl border border-indigo-200 dark:border-indigo-800 bg-indigo-50/40 dark:bg-indigo-900/30 p-4">
                    <div className="text-sm font-semibold text-indigo-900 dark:text-indigo-200">{text('diffRightTitle')}</div>
                    <div className="mt-1 text-xs text-indigo-800/80 dark:text-indigo-300/90">{text('diffRightP1')}</div>
                    <ul className="mt-3 space-y-2 text-sm text-indigo-900 dark:text-indigo-200">
                      <li className="flex gap-2"><span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-indigo-500 shrink-0" />{text('diffRightB1')}</li>
                      <li className="flex gap-2"><span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-indigo-500 shrink-0" />{text('diffRightB2')}</li>
                      <li className="flex gap-2"><span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-indigo-500 shrink-0" />{text('diffRightB3')}</li>
                    </ul>
                  </div>
                </div>
              </details>
            </div>
          </div>

          {agentActive ? (
            <div className="flex-1 min-h-0 flex gap-4">
              {/* Agent chat panel */}
              <div className="flex-1 min-w-0 flex flex-col bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800 shrink-0">
                  <div className="flex items-center gap-2 text-gray-800 dark:text-gray-200">
                    <MessageSquare className="w-5 h-5 text-indigo-500 dark:text-indigo-400" />
                    <h2 className="font-semibold">{locale === 'zh' ? '对话生成' : 'Chat to generate'}</h2>
                    <span className="text-xs text-gray-400 dark:text-gray-500 truncate max-w-[180px]">{workingDir}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowAgentPreview(!showAgentPreview)}
                    className="flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 px-2.5 py-1.5 text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                  >
                    {showAgentPreview ? <PanelRightClose className="w-4 h-4" /> : <PanelRightOpen className="w-4 h-4" />}
                    {showAgentPreview ? (locale === 'zh' ? '收起预览' : 'Hide preview') : (locale === 'zh' ? '展开预览' : 'Show preview')}
                  </button>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto hide-scrollbar p-4 space-y-4">
                  {agentMessages.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-center text-gray-400 dark:text-gray-500 gap-2">
                      <MessageSquare className="w-8 h-8" />
                      <p className="text-sm">{locale === 'zh' ? '用一句话描述你要整理的文稿，剩下的交给对话。' : 'Describe the document you need in one sentence.'}</p>
                      <p className="text-xs">{locale === 'zh' ? '生成结果会自动保存到当前工作目录。' : 'Results are saved to the current working folder automatically.'}</p>
                    </div>
                  ) : (
                    agentMessages.map((msg, index) => (
                      <div key={index} className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
                        <div className={cn(
                          'max-w-[85%] rounded-xl px-3.5 py-2.5 text-sm whitespace-pre-wrap break-words',
                          msg.role === 'user'
                            ? 'bg-indigo-600 text-white'
                            : 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200'
                        )}>
                          {msg.role === 'assistant' ? (
                            <>
                              <p className="line-clamp-6">{msg.content}</p>
                              {msg.savedPath ? (
                                <button
                                  type="button"
                                  onClick={() => handleOpenWorkspaceFile(msg.savedPath!.split(/[\\/]/).pop() || '')}
                                  className="mt-2 inline-flex items-center gap-1 text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
                                >
                                  <FileDown className="w-3.5 h-3.5" />
                                  {msg.savedPath.split(/[\\/]/).pop()}
                                </button>
                              ) : (
                                <span className="mt-2 block text-xs text-gray-400 dark:text-gray-500">
                                  {locale === 'zh' ? '（未选择工作目录，未自动保存）' : '(No workspace selected, not saved)'}
                                </span>
                              )}
                            </>
                          ) : (
                            msg.content
                          )}
                        </div>
                      </div>
                    ))
                  )}
                  {(isFetching || isTyping) && (
                    <div className="flex justify-start">
                      <div className="bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 rounded-xl px-3.5 py-2.5 text-sm flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        {statusMsg || text('generatingDefault')}
                      </div>
                    </div>
                  )}
                </div>

                <div className="p-3 border-t border-gray-100 dark:border-gray-800 shrink-0">
                  {desktopNotice && (
                    <p className="mb-2 text-xs text-emerald-600 dark:text-emerald-400 truncate">{desktopNotice}</p>
                  )}
                  {/* 图片上传 + 教学标注（与文档模式共用同一套上传/标注链路） */}
                  <div className="mb-2 flex items-center gap-2 flex-wrap">
                    <button
                      type="button"
                      onClick={() => agentImageRef.current?.click()}
                      className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                    >
                      <ImagePlus className="w-3.5 h-3.5" />
                      {locale === 'zh' ? `上传图片（${uploadedImages.length}/${MAX_IMAGE_COUNT}）` : `Images (${uploadedImages.length}/${MAX_IMAGE_COUNT})`}
                    </button>
                    <button
                      type="button"
                      onClick={() => setTeachingDocMode(!teachingDocMode)}
                      className={`flex items-center gap-2 text-xs px-2.5 py-1.5 rounded border transition-colors ${teachingDocMode ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300' : 'border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400'}`}
                    >
                      <span className={`relative w-7 h-3.5 rounded-full transition-colors ${teachingDocMode ? 'bg-indigo-500' : 'bg-gray-300 dark:bg-gray-600'}`}>
                        <span className={`absolute top-0.5 left-0.5 w-2.5 h-2.5 rounded-full bg-white transition-transform ${teachingDocMode ? 'translate-x-3.5' : ''}`} />
                      </span>
                      {locale === 'zh' ? '教学文档标注' : 'Teaching annotation'}
                    </button>
                    <input
                      type="file"
                      ref={agentImageRef}
                      accept="image/*"
                      multiple
                      onChange={async (e) => { await handleImageFiles(Array.from(e.target.files || [])); if (agentImageRef.current) agentImageRef.current.value = ''; }}
                      className="hidden"
                    />
                  </div>
                  {uploadedImages.length > 0 && (
                    <div className="mb-2 flex gap-2 overflow-x-auto hide-scrollbar pb-1">
                      {uploadedImages.map((img) => (
                        <div key={img.id} className="relative group shrink-0 w-16 h-16 rounded-md border border-gray-200 dark:border-gray-700 overflow-hidden bg-gray-50 dark:bg-gray-800">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={img.base64} alt="uploaded" className="w-full h-full object-cover" />
                          {annotatingIds.includes(img.id) && (
                            <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-white text-[9px]">{locale === 'zh' ? '标注中' : 'Annot.'}</div>
                          )}
                          {teachingDocMode && img.variant && img.variant > 1 && (
                            <span className="absolute top-0.5 left-0.5 px-1 rounded bg-indigo-600/90 text-white text-[9px]">{locale === 'zh' ? `副本${img.variant}` : `C${img.variant}`}</span>
                          )}
                          <button
                            onClick={() => removeImage(img.id)}
                            className="absolute top-0.5 right-0.5 p-0.5 bg-white/80 dark:bg-gray-800/80 hover:bg-red-100 hover:text-red-600 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <X className="w-3 h-3" />
                          </button>
                          {teachingDocMode && !annotatingIds.includes(img.id) && (
                            <button
                              onClick={() => img.annotated
                                ? handleReannotate(img, [content, agentInput].filter(Boolean).join('\n').slice(0, 1000))
                                : runAnnotation(img.id, img.origBase64, [content, agentInput].filter(Boolean).join('\n').slice(0, 1000))}
                              title={img.annotated
                                ? (locale === 'zh' ? '基于原图再次标注（新增副本）' : 'Annotate again (new copy)')
                                : (locale === 'zh' ? '按当前需求标注' : 'Annotate with current need')}
                              className="absolute bottom-0.5 right-0.5 p-0.5 bg-white/80 dark:bg-gray-800/80 hover:bg-indigo-100 hover:text-indigo-600 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                            >
                              {img.annotated ? <RefreshCw className="w-3 h-3" /> : <Wand2 className="w-3 h-3" />}
                            </button>
                          )}
                          {img.annotated && (
                            <span className="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-[9px] text-center truncate">{locale === 'zh' ? `已标${img.annotationCount ?? 0}` : `${img.annotationCount ?? 0} ann.`}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex items-end gap-2">
                    <textarea
                      value={agentInput}
                      onChange={(e) => setAgentInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAgentSend(); } }}
                      placeholder={locale === 'zh' ? '描述你要整理的文稿，Enter 发送，Shift+Enter 换行' : 'Describe the document, Enter to send'}
                      rows={2}
                      className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-900 focus:ring-2 focus:ring-indigo-500 outline-none resize-none"
                    />
                    <button
                      type="button"
                      onClick={handleAgentSend}
                      disabled={isFetching || isTyping || !agentInput.trim()}
                      className="shrink-0 inline-flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 disabled:cursor-not-allowed text-white px-4 py-2.5 text-sm font-medium transition-colors"
                    >
                      {isFetching || isTyping ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                      {locale === 'zh' ? '发送' : 'Send'}
                    </button>
                  </div>
                  {workspaceFiles.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
                      <p className="text-xs text-gray-400 dark:text-gray-500 mb-1.5">{locale === 'zh' ? '工作目录文件' : 'Workspace files'}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {workspaceFiles.slice(0, 8).map((file) => (
                          <button
                            key={file.name}
                            type="button"
                            onClick={() => handleOpenWorkspaceFile(file.name)}
                            className="max-w-[160px] truncate rounded-md bg-gray-100 dark:bg-gray-800 px-2 py-1 text-[11px] text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                            title={file.name}
                          >
                            {file.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Agent preview panel (collapsed by default) */}
              {showAgentPreview && (
                <div className="hidden lg:flex w-[45%] flex-col bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800 shrink-0">
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{locale === 'zh' ? '预览' : 'Preview'}</span>
                    <button
                      type="button"
                      onClick={() => setIsModalOpen(true)}
                      className="text-gray-500 dark:text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                      title={locale === 'zh' ? '全屏查看' : 'Fullscreen'}
                    >
                      <Maximize2 className="w-4 h-4" />
                    </button>
                  </div>
                  <div
                    ref={resultRef}
                    onScroll={handleScroll}
                    className="p-4 overflow-y-auto flex-1 text-sm prose prose-sm prose-indigo dark:prose-invert max-w-none hide-scrollbar"
                  >
                    {displayedMarkdown ? (
                      <Markdown options={{ overrides: createMarkdownOverrides('max-h-64') }}>
                        {cleanMarkdown}
                      </Markdown>
                    ) : (
                      <p className="text-gray-400 dark:text-gray-500 text-xs">{locale === 'zh' ? '还没有生成内容' : 'Nothing generated yet'}</p>
                    )}
                  </div>
                  <div className="p-3 border-t border-gray-100 dark:border-gray-800 shrink-0 flex gap-2">
                    <button
                      onClick={handleDownload}
                      disabled={isDownloading || !displayedMarkdown}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white px-3 py-2 text-xs font-medium transition-colors"
                    >
                      {isDownloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                      {workingDir ? (locale === 'zh' ? '存入工作目录' : 'Save to workspace') : text('downloadButton')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
          <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-6">
          {/* Left Column: Advanced Settings */}
          <div className="w-full lg:w-[25%] lg:h-full lg:min-h-0 lg:overflow-y-auto lg:pr-2 hide-scrollbar">
            <div
              className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6 outline-none focus-within:ring-2 focus-within:ring-indigo-100 dark:focus-within:ring-indigo-900 lg:min-h-full"
              tabIndex={0}
            >
              <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-6 flex items-center gap-2">
                <SlidersHorizontal className="w-5 h-5 text-indigo-500 dark:text-indigo-400" />
                {text('advancedTitle')}
              </h2>
              <div className="space-y-5">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {text('wordCountLabel')}
                  </label>
                  <input
                    type="number"
                    value={wordCount}
                    onChange={(e) => setWordCount(e.target.value)}
                    placeholder={locale === 'zh' ? '例如: 1000' : 'e.g. 1000'}
                    className="w-full rounded-md border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:ring-1 focus:ring-indigo-500 outline-none bg-white dark:bg-gray-900"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {text('writingStyleLabel')}
                  </label>
                  <select
                    value={writingStyle}
                    onChange={(e) => setWritingStyle(e.target.value)}
                    className="w-full rounded-md border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:ring-1 focus:ring-indigo-500 outline-none bg-white dark:bg-gray-900"
                  >
                    {writingStyleOptions.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {text('eduLevelLabel')}
                  </label>
                  <select
                    value={eduLevel}
                    onChange={(e) => setEduLevel(e.target.value)}
                    className="w-full rounded-md border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:ring-1 focus:ring-indigo-500 outline-none bg-white dark:bg-gray-900"
                  >
                    {eduLevelOptions.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>
                {eduLevel && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      {text('perfLevelLabel')}
                    </label>
                    <select
                      value={perfLevel}
                      onChange={(e) => setPerfLevel(e.target.value)}
                      className="w-full rounded-md border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:ring-1 focus:ring-indigo-500 outline-none bg-white dark:bg-gray-900"
                    >
                      {perfLevelOptions.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                  </div>
                )}
                <div className="flex flex-col gap-2 pt-2 border-t border-gray-100 dark:border-gray-800">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{text('addTyposLabel')}</span>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input type="checkbox" className="sr-only peer" checked={addTypos} onChange={(e) => setAddTypos(e.target.checked)} />
                      <div className="w-11 h-6 bg-gray-200 dark:bg-gray-700 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 dark:peer-focus:ring-indigo-900 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 dark:after:border-gray-500 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                    </label>
                  </div>
                  <span className="text-xs text-gray-500 dark:text-gray-400">{text('addTyposHint')}</span>
                </div>
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{text('humanTraceLabel')}</span>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input type="checkbox" className="sr-only peer" checked={humanTrace} onChange={(e) => setHumanTrace(e.target.checked)} />
                      <div className="w-11 h-6 bg-gray-200 dark:bg-gray-700 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 dark:peer-focus:ring-indigo-900 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 dark:after:border-gray-500 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                    </label>
                  </div>
                  <span className="text-xs text-gray-500 dark:text-gray-400">{text('humanTraceHint')}</span>
                </div>
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{text('evidenceLabel')}</span>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input type="checkbox" className="sr-only peer" checked={enableEvidenceSupport} onChange={(e) => setEnableEvidenceSupport(e.target.checked)} />
                      <div className="w-11 h-6 bg-gray-200 dark:bg-gray-700 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 dark:peer-focus:ring-indigo-900 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 dark:after:border-gray-500 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                    </label>
                  </div>
                  <span className="text-xs text-gray-500 dark:text-gray-400">{text('evidenceHint')}</span>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {text('diagramLabel')}
                  </label>
                  <select
                    value={diagramMode}
                    onChange={(e) => setDiagramMode(e.target.value)}
                    className="w-full rounded-md border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:ring-1 focus:ring-indigo-500 outline-none bg-white dark:bg-gray-900"
                  >
                    {diagramModeOptions.map((mode) => (
                      <option key={mode.value} value={mode.value}>{mode.label}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{text('diagramHint')}</p>
                </div>
              </div>
            </div>

          </div>

          {/* Middle Column: Inputs */}
          <div className="w-full lg:w-[45%] lg:h-full lg:overflow-y-auto lg:pr-2 pb-6 space-y-6 hide-scrollbar">
            {/* Settings Card */}
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
            <div className="flex items-center gap-2 mb-4 text-gray-800 dark:text-gray-200">
              <Settings className="w-5 h-5 text-gray-500 dark:text-gray-400" />
              <h2 className="text-lg font-semibold">{text('generationSettings')}</h2>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {text('promptLabel')} <span className="text-red-500 dark:text-red-400">*</span>
                </label>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onPasteCapture={handleImagePaste}
                  placeholder={text('promptPlaceholder')}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-3 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all resize-none"
                  rows={4}
                />
              </div>
            </div>
          </div>

          {/* Content Card */}
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
            <div
              className="p-6 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors flex items-center justify-between"
              onClick={() => setIsContentOpen(!isContentOpen)}
            >
              <div className="flex items-center gap-2 text-gray-800 dark:text-gray-200">
                <FileText className="w-5 h-5 text-gray-500 dark:text-gray-400" />
                <h2 className="text-lg font-semibold">{text('contentCardTitle')}</h2>
                {content && (
                  <span className="ml-2 text-xs bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 px-2 py-0.5 rounded-full font-medium">
                    {text('contentFilled')}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-gray-500 dark:text-gray-400 hidden sm:inline-block">
                  {text('contentHint')}
                </span>
                <div className="p-1 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400">
                  {isContentOpen ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                </div>
              </div>
            </div>

            {isContentOpen && (
              <div className="px-6 pb-6 border-t border-gray-100 dark:border-gray-800 pt-4 bg-gray-50/30 dark:bg-gray-800/40">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-sm font-medium text-gray-700 dark:text-gray-300">{locale === 'zh' ? '文本内容' : 'Text content'}</div>
                  <div className="flex items-center gap-3">
                    <input
                      type="file"
                      ref={fileInputRef}
                      accept=".docx"
                      onChange={handleFileUpload}
                      className="hidden"
                    />
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isDesktopClient) void handlePickLocalFile();
                        else fileInputRef.current?.click();
                      }}
                      disabled={isUploading}
                      className="text-xs flex items-center gap-1 text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/30 hover:bg-indigo-100 dark:hover:bg-indigo-800/60 px-3 py-1.5 rounded-md transition-colors"
                    >
                      {isUploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                      {isDesktopClient
                        ? (locale === 'zh' ? '选择本地文件' : 'Choose local file')
                        : (locale === 'zh' ? '上传 Word 提取文字' : 'Upload .docx')}
                    </button>
                  </div>
                </div>
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  onPasteCapture={handleImagePaste}
                  placeholder={locale === 'zh' ? '在此粘贴需要美化或润色的文本内容...' : 'Paste the text you want to format or improve...'}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 px-4 py-3 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all resize-none font-mono text-sm bg-white dark:bg-gray-900"
                  rows={8}
                />
              </div>
            )}
          </div>
          {/* Image Upload Section */}
            <div
              className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6 outline-none focus-within:ring-2 focus-within:ring-indigo-100 dark:focus-within:ring-indigo-900"
              tabIndex={0}
              onPasteCapture={handleImagePaste}
            >
              <div className="flex flex-col mb-4 gap-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2 text-gray-800 dark:text-gray-200">
                    <ImagePlus className="w-5 h-5 text-gray-500 dark:text-gray-400" />
                    <h2 className="text-lg font-semibold">{locale === 'zh' ? '上传图片 (可选)' : 'Images (Optional)'}</h2>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setTeachingDocMode(v => !v)}
                      className={`flex items-center gap-2 text-xs px-2 py-1 rounded border transition-colors ${teachingDocMode ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300' : 'border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400'}`}
                      title={locale === 'zh' ? '开启后上传图片会自动分析并在图上标注关键点' : 'When on, uploads are auto-analyzed and annotated'}
                    >
                      <span className={`relative w-8 h-4 rounded-full transition-colors ${teachingDocMode ? 'bg-indigo-500' : 'bg-gray-300 dark:bg-gray-600'}`}>
                        <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${teachingDocMode ? 'translate-x-4' : ''}`} />
                      </span>
                      {locale === 'zh' ? '教学文档标注' : 'Teaching annotation'}
                    </button>
                    <span className="hidden sm:inline text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded">
                      {locale === 'zh' ? '上传图片并要求AI插入到文档中' : 'Upload images and let the model reference them'}
                    </span>
                  </div>
                </div>
                <div className="text-xs text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/30 p-2 rounded-md flex items-start gap-1">
                  <Wand2 className="w-4 h-4 shrink-0" />
                  <span>{locale === 'zh' ? '上传图片后，AI 将会自动分析图片内容并将其插入到文章的相应位置。你也可以点击此区域后直接粘贴图片；若上传 GIF，将自动提取首帧。' : 'The model can analyze uploaded images and place them in the document. Click this area and paste an image directly; GIFs are handled as the first frame.'}</span>
                </div>
                {teachingDocMode && (
                  <div className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 p-2 rounded-md flex items-start gap-1">
                    <span>{locale === 'zh' ? '教学文档模式：上传图片后不会立即标注。请先在上方输入主题/需求，再点缩略图右下角的魔杖按钮标注，或直接点「生成」——AI 会按你的需求挑 1~2 个关键点做紧凑标注（框选/箭头/椭圆/旁注），可反复标注生成不同副本。' : 'Teaching mode: uploads are not annotated immediately. Enter your topic/requirement above, then click the wand button on a thumbnail or hit Generate — AI marks 1~2 key points per your need (box/arrow/ellipse/note); re-annotate for more copies.'}</span>
                  </div>
                )}
              </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {uploadedImages.map((img) => (
                <div key={img.id} className="relative group rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden aspect-square bg-gray-50 dark:bg-gray-800">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={img.base64}
                    alt="uploaded"
                    className="w-full h-full object-cover"
                  />
                  {annotatingIds.includes(img.id) && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-white text-xs">
                      {locale === 'zh' ? '标注中…' : 'Annotating…'}
                    </div>
                  )}
                  {teachingDocMode && img.variant && img.variant > 1 && (
                    <span className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-indigo-600/90 text-white text-[10px] font-medium">
                      {locale === 'zh' ? `副本${img.variant}` : `Copy ${img.variant}`}
                    </span>
                  )}
                  <button
                    onClick={() => removeImage(img.id)}
                    className="absolute top-2 right-2 p-1 bg-white/80 dark:bg-gray-800/80 hover:bg-red-100 hover:text-red-600 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <X className="w-4 h-4" />
                  </button>
                  {teachingDocMode && !annotatingIds.includes(img.id) && (
                    <button
                      onClick={() => img.annotated ? handleReannotate(img, buildAnnotContext()) : runAnnotation(img.id, img.origBase64, buildAnnotContext())}
                      title={img.annotated
                        ? (locale === 'zh' ? '基于原图再次标注（新增一份副本）' : 'Annotate again from the original (new copy)')
                        : (locale === 'zh' ? '按当前需求标注这张图' : 'Annotate this image using the current requirement')}
                      className="absolute bottom-2 right-2 p-1 bg-white/80 dark:bg-gray-800/80 hover:bg-indigo-100 hover:text-indigo-600 rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      {img.annotated ? <RefreshCw className="w-4 h-4" /> : <Wand2 className="w-4 h-4" />}
                    </button>
                  )}
                  <div
                    className="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-[10px] px-2 py-1 truncate"
                    title={img.caption ? `${img.caption}${img.insertHint ? '｜' + img.insertHint : ''}` : undefined}
                  >
                    {img.annotated ? `已标注 ${img.annotationCount ?? 0} 处` : (teachingDocMode ? (locale === 'zh' ? '未标注·点右下角按钮' : 'Not annotated') : `ID: ${img.id}`)}
                  </div>
                </div>
              ))}

              <button
                onClick={() => imageInputRef.current?.click()}
                className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 hover:border-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-800/50 transition-colors aspect-square text-gray-500 dark:text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400"
              >
                <ImagePlus className="w-6 h-6" />
                <span className="text-xs font-medium">{locale === 'zh' ? '添加图片' : 'Add images'}</span>
              </button>
            </div>
            <input
              type="file"
              ref={imageInputRef}
              accept="image/*"
              multiple
              onChange={handleImageUpload}
              className="hidden"
            />
          </div>
          </div>

          {/* Right Column: Actions & Status */}
          <div className="w-full lg:w-[40%] lg:h-full lg:overflow-y-auto lg:pr-2 pb-6 flex flex-col hide-scrollbar">
            <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6 flex flex-col min-h-max lg:min-h-full shrink-0">
              <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-4 shrink-0">{locale === 'zh' ? '操作面板' : 'Actions'}</h2>

              <button
                onClick={handleGenerate}
                disabled={isFetching || isTyping || !accountStatusLoaded || isOffline}
                className={cn(
                  "w-full flex items-center justify-center gap-2 py-3 px-4 rounded-lg font-medium text-white transition-all shadow-sm shrink-0",
                  (isFetching || isTyping || !accountStatusLoaded)
                    ? "bg-indigo-400 cursor-not-allowed"
                    : "bg-indigo-600 hover:bg-indigo-700 hover:shadow"
                )}
              >
                {isFetching || isTyping ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    {statusMsg || text('generatingDefault')}
                  </>
                ) : (
                  <>
                    <Wand2 className="w-5 h-5" />
                    {accountEmail
                      ? (locale === 'zh' ? '开始排版并生成' : 'Generate & Format')
                      : (locale === 'zh' ? '登录并开始排版生成' : 'Sign in to generate')}
                  </>
                )}
              </button>

              <div className="text-xs text-gray-500 dark:text-gray-400 text-center mt-3 shrink-0">
                {locale === 'zh' ? '点击开始排版并生成即表示您同意本站的' : 'By using this site, you agree to the'}
                <button onClick={() => setIsAgreementModalOpen(true)} className="text-indigo-600 dark:text-indigo-400 hover:underline mx-1">{text('agreementBrackets')}</button>
                {locale === 'zh' ? '与' : 'and'}
                <button onClick={() => setIsPrivacyModalOpen(true)} className="text-indigo-600 dark:text-indigo-400 hover:underline ml-1">{text('privacyBrackets')}</button>
              </div>

              {/* Generated Content View */}
              {(displayedMarkdown || isFetching || isTyping) && (
                <div className="mt-6 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden bg-gray-50 dark:bg-gray-800 flex flex-col flex-1 min-h-[300px] transition-all">
                  <div className="bg-gray-100 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-3 py-2 flex items-center justify-between shrink-0">
                    <span className="text-xs font-medium text-gray-600 dark:text-gray-400">{locale === 'zh' ? '生成预览' : 'Preview'}</span>
                    <button
                      onClick={() => setIsModalOpen(true)}
                      className="text-gray-500 dark:text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                      title={locale === 'zh' ? '全屏查看' : 'Fullscreen'}
                    >
                      <Maximize2 className="w-4 h-4" />
                    </button>
                  </div>
                  <div
                    ref={resultRef}
                    onScroll={handleScroll}
                    className="p-4 overflow-y-auto flex-1 text-sm prose prose-sm prose-indigo dark:prose-invert max-w-none custom-scrollbar bg-white dark:bg-gray-900"
                  >
                    {displayedMarkdown ? (
                      <Markdown
                        options={{
                          overrides: createMarkdownOverrides('max-h-64')
                        }}
                      >
                        {cleanMarkdown}
                      </Markdown>
                    ) : (
                      <div className="text-gray-400 dark:text-gray-500 flex items-center justify-center h-full w-full gap-2 animate-pulse">
                        <Loader2 className="w-4 h-4 animate-spin" /> {statusMsg || (locale === 'zh' ? '正在思考中...' : 'Thinking...')}
                      </div>
                    )}
                  </div>
                  <div className="bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 p-3 shrink-0">
                  <button
                    onClick={handleDownload}
                    disabled={isFetching || isTyping || isDownloading || !displayedMarkdown}
                    className={cn(
                      "w-full flex items-center justify-center gap-2 py-2 px-4 rounded-md font-medium transition-all text-sm",
                      (isFetching || isTyping || !displayedMarkdown || isDownloading)
                        ? "bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 cursor-not-allowed"
                        : "bg-green-600 text-white hover:bg-green-700 shadow-sm"
                    )}
                  >
                    {isDownloading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Download className="w-4 h-4" />
                    )}
                    {text('downloadButton')}
                  </button>
                </div>
              </div>
            )}

            {/* Refinement Panel */}
            {(!isFetching && !isTyping && displayedMarkdown) && (
              <div className="mt-4 bg-indigo-50/50 dark:bg-indigo-900/30 rounded-xl border border-indigo-100 dark:border-indigo-900 p-5 shrink-0 transition-all">
                <h3 className="text-sm font-semibold text-indigo-900 dark:text-indigo-200 mb-3 flex items-center gap-2">
                  <Wand2 className="w-4 h-4" />
                  {locale === 'zh' ? '对结果不满意？继续润色优化' : 'Refine the draft'}
                </h3>
                <div className="flex flex-wrap gap-2 mb-4">
                  <button onClick={() => handleRefine(locale === 'zh' ? '请帮我自动润色一下这篇文章，使其更加通顺流畅、用词更专业准确。' : 'Polish the draft for clarity and professionalism.')} className="text-xs bg-white dark:bg-gray-900 border border-indigo-200 dark:border-indigo-800 text-indigo-600 dark:text-indigo-400 px-3 py-1.5 rounded-full hover:bg-indigo-100 dark:hover:bg-indigo-800/60 hover:border-indigo-300 dark:hover:border-indigo-700 transition-colors">{locale === 'zh' ? '自动润色' : 'Polish'}</button>
                  <button onClick={() => handleRefine(locale === 'zh' ? '请帮我扩写当前内容，增加更多的细节和生动的描述，使其更加丰富。' : 'Expand the draft with more detail and examples while keeping it coherent.')} className="text-xs bg-white dark:bg-gray-900 border border-indigo-200 dark:border-indigo-800 text-indigo-600 dark:text-indigo-400 px-3 py-1.5 rounded-full hover:bg-indigo-100 dark:hover:bg-indigo-800/60 hover:border-indigo-300 dark:hover:border-indigo-700 transition-colors">{locale === 'zh' ? '丰富扩写' : 'Expand'}</button>
                  <button onClick={() => handleRefine(locale === 'zh' ? '请帮我精简当前内容，去除冗余词句，保留核心信息即可。' : 'Shorten the draft by removing redundancy while keeping the key information.')} className="text-xs bg-white dark:bg-gray-900 border border-indigo-200 dark:border-indigo-800 text-indigo-600 dark:text-indigo-400 px-3 py-1.5 rounded-full hover:bg-indigo-100 dark:hover:bg-indigo-800/60 hover:border-indigo-300 dark:hover:border-indigo-700 transition-colors">{locale === 'zh' ? '精简缩写' : 'Shorten'}</button>
                  <button onClick={() => handleRefine(locale === 'zh' ? '请帮我调整这篇文章的语气，使其显得更加正式和严谨。' : 'Make the tone more formal and rigorous.')} className="text-xs bg-white dark:bg-gray-900 border border-indigo-200 dark:border-indigo-800 text-indigo-600 dark:text-indigo-400 px-3 py-1.5 rounded-full hover:bg-indigo-100 dark:hover:bg-indigo-800/60 hover:border-indigo-300 dark:hover:border-indigo-700 transition-colors">{locale === 'zh' ? '更正式' : 'More formal'}</button>
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={refinePrompt}
                    onChange={(e) => setRefinePrompt(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleRefine()}
                    placeholder={text('refinePlaceholder')}
                    className="flex-1 rounded-lg border border-indigo-200 dark:border-indigo-800 px-3 py-2 text-sm focus:ring-1 focus:ring-indigo-500 outline-none bg-white dark:bg-gray-900"
                  />
                  <button
                    onClick={() => handleRefine()}
                    disabled={!refinePrompt.trim()}
                    className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                  >
                    {text('refineButton')}
                  </button>
                </div>
              </div>
            )}

            {/* Status Messages */}
              <div className="mt-6 space-y-4 shrink-0">
                {error && (
                  <div className="p-4 bg-red-50 dark:bg-red-900/30 border border-red-100 dark:border-red-900 rounded-lg flex items-start gap-3 text-red-700 dark:text-red-400">
                    <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                    <div className="text-sm">
                      <p>{error}</p>
                      {requiresLogin && <Link href="/login?returnTo=%2F" className="mt-2 inline-block font-medium text-indigo-700 dark:text-indigo-300 underline underline-offset-2">{locale === 'zh' ? '登录或注册' : 'Sign in or create an account'}</Link>}
                    </div>
                  </div>
                )}

                {success && (
                  <div className="p-4 bg-green-50 dark:bg-green-900/30 border border-green-100 dark:border-green-900 rounded-lg flex items-start gap-3 text-green-700 dark:text-green-400">
                    <Download className="w-5 h-5 shrink-0 mt-0.5" />
                    <p className="text-sm">{text('generateSuccess')}</p>
                  </div>
                )}

                <div className="pt-6 border-t border-gray-100 dark:border-gray-800 pb-4">
                  <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">{locale === 'zh' ? '使用说明与免责声明' : 'Usage & Disclaimer'}</h3>
                  <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-2 list-disc list-inside pl-1 mb-4">
                    <li>{locale === 'zh' ? '生成和下载需先登录账号。' : 'Sign in is required to generate and download documents.'}</li>
                    <li><strong>{locale === 'zh' ? '直接生成：' : 'Generate:'}</strong> {locale === 'zh' ? '输入要求并点击生成，即可获得结构清晰、可下载的 Word 文档。' : 'Enter instructions and click Generate to get a well-structured draft and a downloadable .docx.'}</li>
                    <li><strong>{locale === 'zh' ? '排版美化：' : 'Beautify:'}</strong> {locale === 'zh' ? '粘贴已有内容或上传 .docx，并在要求中说明目标风格与结构。' : 'Paste existing content or upload a .docx, then describe the desired style and structure.'}</li>
                    <li>{locale === 'zh' ? '生成速度取决于内容长度与所选模型，请耐心等待。' : 'Generation speed depends on content length and the selected model. Please wait.'}</li>
                    <li>{locale === 'zh' ? '请勿上传敏感信息（身份证、银行卡、账号密码、商业机密等）。' : 'Do not upload sensitive information (IDs, bank details, passwords, trade secrets, etc.).'}</li>
                  </ul>
                </div>
              </div>

              {/* Author & Date Settings Card */}
              <div className="mt-6 border-t border-gray-100 dark:border-gray-800 pt-6">
                <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-6 flex items-center gap-2">
                  <FileText className="w-5 h-5 text-indigo-500 dark:text-indigo-400" />
                  {text('signatureTitle')}
                </h2>
                <div className="space-y-5">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{text('signatureToggle')}</span>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input type="checkbox" className="sr-only peer" checked={enableSignatureDate} onChange={(e) => setEnableSignatureDate(e.target.checked)} />
                      <div className="w-11 h-6 bg-gray-200 dark:bg-gray-700 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 dark:peer-focus:ring-indigo-900 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 dark:after:border-gray-500 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                    </label>
                  </div>
                  {enableSignatureDate ? (
                    <>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                          {text('authorLabel')}
                        </label>
                        <input
                          type="text"
                          value={authorName}
                          onChange={(e) => setAuthorName(e.target.value)}
                          placeholder={text('authorPlaceholder')}
                          className="w-full rounded-md border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:ring-1 focus:ring-indigo-500 outline-none bg-white dark:bg-gray-900"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                          {text('dateLabel')}
                        </label>
                        <input
                          type="text"
                          value={documentDate}
                          onChange={(e) => setDocumentDate(e.target.value)}
                          placeholder={text('datePlaceholder')}
                          className="w-full rounded-md border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:ring-1 focus:ring-indigo-500 outline-none bg-white dark:bg-gray-900"
                        />
                      </div>
                    </>
                  ) : (
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {text('signatureOffHint')}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
        )}
        </div>
      </main>

      {/* Footer */}
      <footer className="bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 shrink-0 py-3 sm:py-4">
        <div className="max-w-7xl mx-auto px-4 text-center text-xs sm:text-sm text-gray-500 dark:text-gray-400 flex flex-col sm:flex-row items-center justify-center gap-1.5 sm:gap-6">
          <p>{text('footerBrand')}</p>
          <p className="hidden sm:block">|</p>
          <a
            href="https://github.com/violet27chen/ai-word-beautifier"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="w-4 h-4">
              <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
            </svg>
            {locale === 'zh' ? '本项目开源' : 'Open source'}
          </a>
          <p className="hidden sm:block">|</p>
          <div className="flex items-center gap-4">
            <button onClick={() => setIsAgreementModalOpen(true)} className="hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors">{text('agreement')}</button>
            <button onClick={() => setIsPrivacyModalOpen(true)} className="hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors">{text('privacy')}</button>
          </div>
        </div>
      </footer>

      {/* Generation History Modal */}
      {isHistoryOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between p-4 border-b border-gray-100 dark:border-gray-800">
              <h3 className="font-semibold text-gray-800 dark:text-gray-200 text-lg">{locale === 'zh' ? '历史生成记录' : 'Generation history'}</h3>
              <button
                onClick={() => setIsHistoryOpen(false)}
                className="p-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-full text-gray-600 dark:text-gray-400 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 overflow-y-auto flex-1 custom-scrollbar">
              {historyError && (
                <p className="mb-3 rounded-md bg-red-50 dark:bg-red-900/30 px-3 py-2 text-xs text-red-600 dark:text-red-400">{historyError}</p>
              )}
              {historyLoading ? (
                <div className="py-12 flex items-center justify-center gap-2 text-sm text-gray-400 dark:text-gray-500">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {locale === 'zh' ? '加载中...' : 'Loading...'}
                </div>
              ) : historyItems.length === 0 ? (
                <div className="py-12 text-center text-sm text-gray-400 dark:text-gray-500">
                  {locale === 'zh' ? '暂无历史记录，生成后会自动保存到这里。' : 'No history yet. Generated documents are saved here automatically.'}
                </div>
              ) : (
                <div className="space-y-3">
                  {historyItems.map((item) => (
                    <div
                      key={item.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setHistoryConfirm({ type: 'restore', id: item.id, title: item.title })}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setHistoryConfirm({ type: 'restore', id: item.id, title: item.title }); }}
                      className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 cursor-pointer hover:border-indigo-400 dark:hover:border-indigo-600 hover:bg-indigo-50/40 dark:hover:bg-indigo-900/20 transition-colors"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{item.title}</p>
                          <p className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">
                            {new Date(item.createdAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                            {' · '}
                            {locale === 'zh' ? `约 ${item.wordCount} 字` : `~${item.wordCount} words`}
                          </p>
                          {item.snippet && (
                            <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400 line-clamp-2 whitespace-pre-wrap break-words">{item.snippet}</p>
                          )}
                        </div>
                        <button
                          onClick={(e) => { e.stopPropagation(); setHistoryConfirm({ type: 'delete', id: item.id, title: item.title }); }}
                          title={locale === 'zh' ? '删除' : 'Delete'}
                          className="p-2 rounded-md text-gray-500 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors shrink-0"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {historyTotal > HISTORY_PAGE_SIZE && (
              <div className="flex items-center justify-between p-3 border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
                <button
                  onClick={() => loadHistory(historyPage - 1)}
                  disabled={historyPage <= 1 || historyLoading}
                  className="flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                  {locale === 'zh' ? '上一页' : 'Prev'}
                </button>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {locale === 'zh' ? `第 ${historyPage} / ${Math.ceil(historyTotal / HISTORY_PAGE_SIZE)} 页（共 ${historyTotal} 条）` : `Page ${historyPage} of ${Math.ceil(historyTotal / HISTORY_PAGE_SIZE)} (${historyTotal} items)`}
                </span>
                <button
                  onClick={() => loadHistory(historyPage + 1)}
                  disabled={historyPage >= Math.ceil(historyTotal / HISTORY_PAGE_SIZE) || historyLoading}
                  className="flex items-center gap-1 rounded-md border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-xs text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {locale === 'zh' ? '下一页' : 'Next'}
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* History Confirm Modal */}
      {historyConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-sm overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="p-5">
              <h3 className="font-semibold text-gray-800 dark:text-gray-200">
                {historyConfirm.type === 'restore' ? (locale === 'zh' ? '恢复到预览区' : 'Restore to preview') : (locale === 'zh' ? '删除这条记录' : 'Delete this entry')}
              </h3>
              <p className="mt-2 text-sm text-gray-500 dark:text-gray-400 break-words">
                {historyConfirm.type === 'restore'
                  ? (locale === 'zh'
                    ? `将把「${historyConfirm.title}」的内容恢复到预览区，当前预览内容会被替换。`
                    : `"${historyConfirm.title}" will be restored to the preview area and replace the current content.`)
                  : (locale === 'zh'
                    ? `确定删除「${historyConfirm.title}」吗？删除后无法恢复。`
                    : `Delete "${historyConfirm.title}"? This cannot be undone.`)}
              </p>
            </div>
            <div className="flex justify-end gap-3 px-5 py-4 bg-gray-50 dark:bg-gray-800/50 border-t border-gray-100 dark:border-gray-800">
              <button
                onClick={() => setHistoryConfirm(null)}
                className="py-2 px-4 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                {locale === 'zh' ? '取消' : 'Cancel'}
              </button>
              <button
                onClick={() => (historyConfirm.type === 'restore' ? handleRestoreHistory(historyConfirm.id) : handleDeleteHistory(historyConfirm.id))}
                className={cn(
                  'py-2 px-4 rounded-lg text-sm font-medium text-white shadow-sm transition-colors',
                  historyConfirm.type === 'delete' ? 'bg-red-600 hover:bg-red-700' : 'bg-indigo-600 hover:bg-indigo-700'
                )}
              >
                {historyConfirm.type === 'restore' ? (locale === 'zh' ? '确认恢复' : 'Restore') : (locale === 'zh' ? '确认删除' : 'Delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Privacy Policy Modal */}
      {isPrivacyModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between p-4 border-b border-gray-100 dark:border-gray-800">
              <h3 className="font-semibold text-gray-800 dark:text-gray-200 text-lg">{text('privacyTitle')}</h3>
              <button
                onClick={() => setIsPrivacyModalOpen(false)}
                className="p-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-full text-gray-600 dark:text-gray-400 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6 overflow-y-auto flex-1 prose prose-sm dark:prose-invert max-w-none text-gray-600 dark:text-gray-400 custom-scrollbar">
              {locale === 'zh' ? (
                <>
                  <h4>1. 数据收集与流转</h4>
                  <p>注册和验证邮箱时，我们会处理您的邮箱地址、邮箱验证码及其有效期，并保存密码派生摘要（不保存明文密码）、账号创建/最近登录时间和服务端会话摘要；登录状态由 HttpOnly Cookie 维持。生成和下载功能仅向已登录用户开放，相关请求会关联账号，用于统计请求类型、结果、时间、输入长度、图片使用情况及错误摘要。为估算访问量和独立访客，我们会记录访问 IP 地址及浏览器 User-Agent；登录相关限频使用由 IP 派生的摘要标识。本应用业务数据库不保存您提交的提示词、文档正文或图片原始内容；但为提供历史记录功能，您成功生成的文档内容会自动保存至您的账号历史记录（每账号最多保留最近 100 条，可在页面「历史」中查看或删除）。账号、会话、必要的统计数据及历史记录存储在本服务配置的数据库（Cloudflare D1 或 MySQL）中。</p>
                  <h4>2. 上游数据安全与隐私边界</h4>
                  <p>为提供服务，您提交的提示词、文档内容及图片会通过 HTTPS 发送给 DeepSeek（模型：deepseek-flash）处理；验证邮箱和重置密码所需的邮箱地址及邮件内容会交由配置的邮件服务商发送；本服务运行及数据库由 Cloudflare 或配置的 MySQL 服务提供基础设施支持。各服务商对其所处理数据的保存和使用受其自身政策约束，本平台无法控制或代其作出承诺。请勿提交国家秘密、商业秘密、账号凭证或不必要的敏感个人信息。</p>
                  <h4>3. 模型训练声明</h4>
                  <p>本应用不会将您提交的内容用于训练或微调本应用自有模型。本应用使用 DeepSeek API 提供模型推理；DeepSeek 对 API 请求数据的处理、保存及是否用于模型改进，以 DeepSeek 当时有效的官方政策为准，本应用不对第三方政策作保证。</p>
                  <h4>4. 政策更新</h4>
                  <p>我们保留随时更新本政策的权利。本政策变更后将以最新版本为准。</p>
                </>
              ) : (
                <>
                  <h4>1. Data flow</h4>
                  <p>For registration and email verification, we process your email address and verification code (including its expiry), and store a derived password hash (not your plaintext password), account timestamps, and a server-side session hash; an HttpOnly cookie maintains your signed-in state. Generation and download are available only to signed-in users. Related requests are associated with your account for usage analytics (request type, result, time, input length, image usage, and error summary). We record visitor IP addresses and browser User-Agent values to estimate visits and unique visitors; sign-in rate limiting uses a derived IP identifier. The application database does not store submitted prompts, document text, or original image contents; however, to provide the history feature, each successfully generated document is saved to your per-account history (up to the most recent 100 entries, viewable and deletable from the History panel). Account, session, and necessary analytics data, along with generation history, are stored in the configured database (Cloudflare D1 or MySQL).</p>
                  <h4>2. Third-party processing</h4>
                  <p>Your prompts, document content, and images are sent over HTTPS to DeepSeek (model: deepseek-flash) for processing. Email addresses and message content needed for verification and password resets are sent through the configured email provider. Cloudflare or the configured MySQL provider supplies the service infrastructure and database. Each provider processes data under its own policies; this site cannot control or make promises on their behalf. Do not submit state secrets, trade secrets, credentials, or unnecessary sensitive personal information.</p>
                  <h4>3. Model training</h4>
                  <p>This application does not use your inputs to train or fine-tune an application-owned model. DeepSeek processes requests through its API; its handling, retention, and use of API data for model improvement are governed by its then-current official policies, which this site cannot guarantee on its behalf.</p>
                  <h4>4. Updates</h4>
                  <p>We may update this policy from time to time. The latest version will apply.</p>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* User Agreement Modal */}
      {isAgreementModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between p-4 border-b border-gray-100 dark:border-gray-800">
              <h3 className="font-semibold text-gray-800 dark:text-gray-200 text-lg">{text('agreementTitle')}</h3>
              <button
                onClick={() => setIsAgreementModalOpen(false)}
                className="p-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-full text-gray-600 dark:text-gray-400 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-6 overflow-y-auto flex-1 prose prose-sm dark:prose-invert max-w-none text-gray-600 dark:text-gray-400 custom-scrollbar">
              {locale === 'zh' ? (
                <>
                  <h4>1. 服务说明</h4>
                  <p>&quot;AI Word 排版美化助手&quot;为您提供基于人工智能的文档生成与排版美化服务。浏览网站无需登录；使用生成和下载功能须注册账号、完成邮箱验证并保持登录状态。您应妥善保管账号凭证，并合法、合规地使用本工具，不得利用本工具生成违反适用法律法规、危害公共安全或侵犯他人合法权益的内容。</p>
                  <h4>2. 知识产权与版权风险申明</h4>
                  <p>本平台不主动使用未经授权的特定字体、模板或受版权保护的图片进行内容生成。但请注意，由于 AI 模型的特性，生成的文本或内容可能偶有雷同，或者模型在训练时可能受到未知数据的干扰。<strong>用户需自行对使用本工具生成的文档负责，并承担因商用等目的引发的任何版权、著作权纠纷的直接或间接法律责任。</strong></p>
                  <h4>3. 服务的可用性与免责声明</h4>
                  <p>由于网络环境、第三方 AI 接口稳定性等不可抗力因素，本服务不保证 100% 的持续可用性。因服务中断、数据丢失导致的任何直接或间接损失，本平台不承担赔偿责任。</p>
                  <h4>4. 违规行为处理</h4>
                  <p>若发现用户恶意利用本平台生成涉黄、涉暴、涉政等违法违规内容，我们有权立即停止为其提供服务，并配合有关部门的调查。</p>
                </>
              ) : (
                <>
                  <h4>1. Service description</h4>
                  <p>This site provides AI-assisted document generation and formatting. Browsing does not require an account, but generation and downloads require a registered account, verified email address, and signed-in session. You are responsible for safeguarding your account credentials and using the service lawfully; do not generate content that violates applicable laws or infringes others&apos; rights.</p>
                  <h4>2. IP and copyright</h4>
                  <p>AI-generated content may be similar to existing materials. You are responsible for reviewing outputs and ensuring you have the necessary rights before using them commercially.</p>
                  <h4>3. Availability disclaimer</h4>
                  <p>The service depends on network conditions and third-party model providers. We do not guarantee uninterrupted availability and are not liable for losses caused by outages.</p>
                  <h4>4. Abuse</h4>
                  <p>We may suspend access in cases of abuse, illegal usage, or attempts to disrupt the service.</p>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Mobile Modal for Markdown Preview */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-4xl h-full max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between p-4 border-b border-gray-100 dark:border-gray-800">
              <h3 className="font-semibold text-gray-800 dark:text-gray-200">{locale === 'zh' ? '文档预览' : 'Document preview'}</h3>
              <button
                onClick={() => setIsModalOpen(false)}
                className="p-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-full text-gray-600 dark:text-gray-400 transition-colors"
              >
                <Minimize2 className="w-4 h-4" />
              </button>
            </div>
            <div
              ref={modalResultRef}
              onScroll={handleScroll}
              className="overflow-y-auto flex-1 max-w-none custom-scrollbar word-preview-container"
            >
              {displayedMarkdown ? (
                <div className="word-preview-page prose prose-base">
                  <Markdown
                    options={{
                      overrides: createMarkdownOverrides('max-h-96')
                    }}
                  >
                    {cleanMarkdown}
                  </Markdown>
                </div>
              ) : null}
            </div>
            <div className="p-4 border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800 flex flex-col sm:flex-row justify-end gap-3">
              {(!isFetching && !isTyping && displayedMarkdown) && (
                <button
                  onClick={handleCopy}
                  className="w-full sm:w-auto flex items-center justify-center gap-2 py-2 px-6 rounded-lg font-medium bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 shadow-sm transition-all"
                >
                  {isCopied ? <Check className="w-5 h-5 text-green-600 dark:text-green-400" /> : <Copy className="w-5 h-5" />}
                  {isCopied ? (locale === 'zh' ? '已复制' : 'Copied') : (locale === 'zh' ? '复制内容' : 'Copy')}
                </button>
              )}
              <button
                onClick={() => {
                  setIsModalOpen(false);
                  handleDownload();
                }}
                className="w-full sm:w-auto flex items-center justify-center gap-2 py-2 px-6 rounded-lg font-medium bg-green-600 text-white hover:bg-green-700 shadow-sm transition-all"
              >
                <Download className="w-5 h-5" />
                {text('downloadButton')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
