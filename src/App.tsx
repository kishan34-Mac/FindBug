import { useState, useEffect } from 'react';
import {
  Globe,
  Search,
  Camera,
  Network,
  Gauge,
  Brain,
  CheckCircle2,
  AlertCircle,
  FileText,
  RefreshCw,
  Monitor,
  Server,
  Bug,
  Smartphone,
  Zap,
  ChevronRight,
  Eye,
} from 'lucide-react';

type AppState = 'input' | 'loading' | 'results';

type Severity = 'Critical' | 'High' | 'Medium' | 'Low';

interface Issue {
  id: number;
  title: string;
  severity: Severity;
  description: string;
  exactPageUrl: string;
  evidence: string;
  screenshot?: string;
  networkLog?: string;
  domSelector?: string;
  consoleError?: string;
  apiResponse?: string;
  reproducible: string;
  confidence: number;
  reproductionSteps: string;
  recommendedFix: string;
  observationOnly: boolean;
}

interface IssueCategory {
  title: string;
  icon: React.ReactNode;
  iconColor: string;
  bgColor: string;
  issues: Issue[];
}

const severityColors: Record<Severity, { dot: string; badge: string; text: string }> = {
  Critical: { dot: 'bg-red-500', badge: 'bg-red-100 text-red-700', text: 'text-red-600' },
  High: { dot: 'bg-orange-500', badge: 'bg-orange-100 text-orange-700', text: 'text-orange-600' },
  Medium: { dot: 'bg-yellow-500', badge: 'bg-yellow-100 text-yellow-700', text: 'text-yellow-600' },
  Low: { dot: 'bg-blue-500', badge: 'bg-blue-100 text-blue-700', text: 'text-blue-600' },
};

const pipelineSteps = [
  { label: 'Capturing Frontend Screenshots & UI...', icon: Camera },
  { label: 'Logging Network & Backend APIs...', icon: Network },
  { label: 'Running Performance Benchmarks...', icon: Gauge },
  { label: 'AI Synthesizing Audit Report...', icon: Brain },
];

const dummyIssues: Record<string, Issue[]> = {
  frontend: [],
  backend: [],
  functional: [],
  responsive: [],
  performance: [],
  seo: [],
  accessibility: [],
};

function App() {
  const [appState, setAppState] = useState<AppState>('input');
  const [url, setUrl] = useState('');
  const [issues, setIssues] = useState(dummyIssues);
  const [currentStep, setCurrentStep] = useState(0);
  const [completedSteps, setCompletedSteps] = useState<number[]>([]);
  const [progressWidth, setProgressWidth] = useState(0);
  const [showDetailed, setShowDetailed] = useState(false);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<{
    dnsLookupTime: number;
    tcpConnectTime: number;
    ttfb: number;
    domContentLoaded: number;
    pageLoadTime: number;
  } | null>(null);
  const [scanDate] = useState(new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }));

  const handleAnalyze = () => {
    if (!url.trim()) return;
    setAppState('loading');
    setCurrentStep(0);
    setCompletedSteps([]);
    setProgressWidth(0);
  };

  useEffect(() => {
    if (appState !== 'loading') return;

    let pollInterval: NodeJS.Timeout;
    const startTime = Date.now();
    const clientTimeoutLimit = 5 * 60 * 1000; // 5 minutes client timeout

    const runPipeline = async () => {
      try {
        const apiUrl = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '/_/backend' : 'http://localhost:5001');

        // Step 1: Submit the audit job
        const submitResponse = await fetch(`${apiUrl}/api/audit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        });

        const submitData = await submitResponse.json();

        if (!submitResponse.ok) {
          throw new Error(submitData.details || submitData.error || 'Failed to submit audit job');
        }

        const jobId = submitData.jobId;

        // Step 2: Poll status
        pollInterval = setInterval(async () => {
          try {
            // Check client timeout limit
            if (Date.now() - startTime > clientTimeoutLimit) {
              clearInterval(pollInterval);
              throw new Error('Audit timed out.');
            }

            const statusResponse = await fetch(`${apiUrl}/api/audit/status/${jobId}`);
            const statusData = await statusResponse.json();

            if (!statusResponse.ok) {
              throw new Error(statusData.error || 'Error fetching status');
            }

            const progress = statusData.progress || 0;
            setProgressWidth(progress);

            // Update current step index based on progress
            const newStep = Math.min(
              pipelineSteps.length - 1,
              Math.floor((progress / 100) * pipelineSteps.length)
            );
            setCurrentStep(newStep);

            // Calculate completed steps
            const completed: number[] = [];
            for (let i = 0; i < pipelineSteps.length; i++) {
              const stepThreshold = ((i + 1) / pipelineSteps.length) * 100;
              if (progress >= stepThreshold) {
                completed.push(i);
              }
            }
            setCompletedSteps(completed);

            if (statusData.status === 'COMPLETED' && statusData.report) {
              clearInterval(pollInterval);

              const report = statusData.report;
              interface RawIssue {
                issue: string;
                description: string;
                severity: Severity;
                exactPageUrl: string;
                evidence: string;
                screenshot?: string;
                networkLog?: string;
                domSelector?: string;
                consoleError?: string;
                apiResponse?: string;
                reproducible: string;
                confidence: number;
                reproductionSteps: string;
                recommendedFix: string;
                observationOnly: boolean;
              }
              const addIds = (arr: RawIssue[]) => arr.map((item, i) => ({
                ...item,
                id: i + 1,
                title: item.issue,
                description: item.description || 'No description provided'
              }));

              setIssues({
                frontend: addIds(report.frontendIssues || []),
                backend: addIds(report.backendIssues || []),
                functional: addIds(report.functionalBugs || []),
                responsive: addIds(report.responsivenessIssues || []),
                performance: addIds(report.performanceIssues || []),
                seo: addIds(report.seoIssues || []),
                accessibility: addIds(report.accessibilityIssues || [])
              });

              setScreenshot(report.screenshot || null);
              setMetrics(report.performanceMetrics || null);

              setProgressWidth(100);
              setCompletedSteps(pipelineSteps.map((_, i) => i));
              setCurrentStep(pipelineSteps.length);

              setTimeout(() => {
                setAppState('results');
              }, 600);
            } else if (statusData.status === 'FAILED') {
              clearInterval(pollInterval);
              throw new Error(statusData.error || 'Audit job failed on the backend');
            } else if (statusData.status === 'TIMED_OUT') {
              clearInterval(pollInterval);
              throw new Error(statusData.error || 'Audit job timed out on the backend');
            }
          } catch (pollErr) {
            const err = pollErr as Error;
            clearInterval(pollInterval);
            console.error('Polling error:', err);
            alert(`Error: ${err.message || 'Failed to update audit status.'}`);
            setAppState('input');
          }
        }, 1500);

      } catch (error) {
        console.error('Audit error:', error);
        const err = error as Error;
        alert(`Error: ${err.message || 'Failed to generate audit report.'}`);
        setAppState('input');
      }
    };

    runPipeline();

    return () => {
      if (pollInterval) {
        clearInterval(pollInterval);
      }
    };
  }, [appState, url]);

  const handleNewScan = () => {
    setUrl('');
    setAppState('input');
    setCurrentStep(0);
    setCompletedSteps([]);
    setProgressWidth(0);
  };

  const categories: IssueCategory[] = [
    { title: 'Frontend Issues', icon: <Monitor className="w-5 h-5" />, iconColor: 'text-indigo-600', bgColor: 'bg-indigo-100', issues: issues.frontend.filter(i => !i.observationOnly) },
    { title: 'Backend Issues', icon: <Server className="w-5 h-5" />, iconColor: 'text-emerald-600', bgColor: 'bg-emerald-100', issues: issues.backend.filter(i => !i.observationOnly) },
    { title: 'Functional Bugs', icon: <Bug className="w-5 h-5" />, iconColor: 'text-purple-600', bgColor: 'bg-purple-100', issues: issues.functional.filter(i => !i.observationOnly) },
    { title: 'Responsiveness Issues', icon: <Smartphone className="w-5 h-5" />, iconColor: 'text-cyan-600', bgColor: 'bg-cyan-100', issues: issues.responsive.filter(i => !i.observationOnly) },
    { title: 'Performance Issues', icon: <Zap className="w-5 h-5" />, iconColor: 'text-amber-600', bgColor: 'bg-amber-100', issues: issues.performance.filter(i => !i.observationOnly) },
    { title: 'SEO Issues', icon: <Search className="w-5 h-5" />, iconColor: 'text-rose-600', bgColor: 'bg-rose-100', issues: issues.seo.filter(i => !i.observationOnly) },
    { title: 'Accessibility Issues', icon: <Eye className="w-5 h-5" />, iconColor: 'text-sky-600', bgColor: 'bg-sky-100', issues: issues.accessibility.filter(i => !i.observationOnly) },
  ];

  const totalIssues = categories.reduce((sum, cat) => sum + cat.issues.length, 0);
  const criticalCount = categories.reduce(
    (sum, cat) => sum + cat.issues.filter((i) => i.severity === 'Critical').length,
    0
  );
  const highCount = categories.reduce(
    (sum, cat) => sum + cat.issues.filter((i) => i.severity === 'High').length,
    0
  );

  const observations: Issue[] = [
    ...issues.frontend.filter(i => i.observationOnly),
    ...issues.backend.filter(i => i.observationOnly),
    ...issues.functional.filter(i => i.observationOnly),
    ...issues.responsive.filter(i => i.observationOnly),
    ...issues.performance.filter(i => i.observationOnly),
    ...issues.seo.filter(i => i.observationOnly),
    ...issues.accessibility.filter(i => i.observationOnly),
  ];

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      {appState === 'input' && (
        <div className="min-h-screen flex items-center justify-center px-4">
          <div className="max-w-2xl w-full text-center animate-fade-in">
            <div className="mb-8">
              <h1 className="text-5xl sm:text-6xl font-extrabold text-slate-900 tracking-tight mb-4">
                Automated Review Team
              </h1>
              <p className="text-xl text-slate-600 max-w-lg mx-auto">
                Comprehensive website QA audits powered by AI. Detect bugs, performance issues, and accessibility problems in seconds.
              </p>
            </div>

            <div className="bg-white rounded-2xl shadow-xl border border-slate-200 p-6 sm:p-8">
              <div className="flex items-center gap-3 mb-6">
                <div className="flex-1 relative">
                  <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                    <Globe className="w-5 h-5 text-slate-400" />
                  </div>
                  <input
                    type="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://your-website.com"
                    className="w-full pl-12 pr-4 py-4 text-lg border-2 border-slate-200 rounded-xl focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 outline-none transition-all duration-200"
                  />
                </div>
              </div>

              <button
                onClick={handleAnalyze}
                disabled={!url.trim()}
                className="w-full sm:w-auto px-8 py-4 bg-slate-900 text-white font-semibold rounded-xl hover:bg-slate-800 disabled:bg-slate-300 disabled:cursor-not-allowed transition-all duration-200 flex items-center justify-center gap-2 mx-auto"
              >
                <Search className="w-5 h-5" />
                Analyze Website
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>

            <p className="mt-6 text-sm text-slate-500">
              Powered by AI-driven analysis across frontend, backend, and performance dimensions
            </p>
          </div>
        </div>
      )}

      {appState === 'loading' && (
        <div className="min-h-screen flex items-center justify-center px-4 bg-slate-50">
          <div className="max-w-xl w-full animate-fade-in">
            <div className="bg-white rounded-2xl shadow-xl border border-slate-200 p-8">
              <h2 className="text-2xl font-bold text-slate-900 mb-2 text-center">Running Analysis</h2>
              <p className="text-slate-500 text-center mb-8">Scanning {url} for issues...</p>

              <div className="space-y-4 mb-8">
                {pipelineSteps.map((step, index) => {
                  const isCompleted = completedSteps.includes(index);
                  const isActive = currentStep === index && !isCompleted;
                  const Icon = step.icon;

                  return (
                    <div
                      key={index}
                      className={`flex items-center gap-4 p-4 rounded-xl transition-all duration-300 ${
                        isCompleted
                          ? 'bg-green-50 border border-green-200'
                          : isActive
                          ? 'bg-indigo-50 border border-indigo-200'
                          : 'bg-slate-50 border border-slate-100'
                      }`}
                    >
                      <div
                        className={`w-10 h-10 rounded-full flex items-center justify-center ${
                          isCompleted
                            ? 'bg-green-500'
                            : isActive
                            ? 'bg-indigo-500'
                            : 'bg-slate-200'
                        }`}
                      >
                        {isCompleted ? (
                          <CheckCircle2 className="w-5 h-5 text-white" />
                        ) : isActive ? (
                          <Icon className="w-5 h-5 text-white animate-spin" />
                        ) : (
                          <Icon className="w-5 h-5 text-slate-400" />
                        )}
                      </div>
                      <span
                        className={`font-medium ${
                          isCompleted
                            ? 'text-green-700'
                            : isActive
                            ? 'text-indigo-700'
                            : 'text-slate-400'
                        }`}
                      >
                        {step.label}
                      </span>
                    </div>
                  );
                })}
              </div>

              <div className="space-y-2">
                <div className="flex justify-between text-sm text-slate-600">
                  <span>Progress</span>
                  <span>{Math.round(progressWidth)}%</span>
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${progressWidth}%` }}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {appState === 'results' && (
        <div className="min-h-screen bg-slate-50 animate-fade-in">
          <header className="sticky top-0 z-50 bg-white/80 backdrop-blur-lg border-b border-slate-200">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-xl flex items-center justify-center">
                    <AlertCircle className="w-6 h-6 text-white" />
                  </div>
                  <div>
                    <h1 className="text-xl font-bold text-slate-900">Automated Review Team</h1>
                    <p className="text-sm text-slate-500">Website QA Audit Report</p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="px-3 py-1.5 bg-slate-100 text-slate-700 text-sm font-medium rounded-lg flex items-center gap-1.5">
                    <Globe className="w-4 h-4 text-slate-500" />
                    {url}
                  </span>
                  <span className="px-3 py-1.5 bg-slate-100 text-slate-600 text-sm rounded-lg">
                    {scanDate}
                  </span>
                  <span className="px-3 py-1.5 bg-red-100 text-red-700 text-sm font-semibold rounded-lg">
                    {totalIssues} Issues
                  </span>
                  <span className="px-3 py-1.5 bg-gradient-to-r from-green-500 to-emerald-500 text-white text-sm font-semibold rounded-lg">
                    Score: 72/100
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => window.print()}
                    className="px-4 py-2 bg-white border border-slate-200 text-slate-700 font-medium rounded-lg hover:bg-slate-50 transition-colors flex items-center gap-2"
                  >
                    <FileText className="w-4 h-4" />
                    Export PDF
                  </button>
                  <button
                    onClick={handleNewScan}
                    className="px-4 py-2 bg-slate-900 text-white font-medium rounded-lg hover:bg-slate-800 transition-colors flex items-center gap-2"
                  >
                    <RefreshCw className="w-4 h-4" />
                    New Scan
                  </button>
                </div>
              </div>
            </div>
          </header>

          <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            {/* Visual Screenshot and Performance Metrics Dashboard */}
            {(metrics || screenshot) && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
                {/* Performance Metrics Card */}
                {metrics && (
                  <div className="lg:col-span-1 bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-col justify-between">
                    <div>
                      <h3 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2">
                        <Zap className="w-5 h-5 text-amber-500" />
                        Performance Timing
                      </h3>
                      <div className="space-y-3">
                        <div className="flex justify-between items-center text-sm border-b border-slate-100 pb-2">
                          <span className="text-slate-500">DNS Lookup Time</span>
                          <span className="font-semibold text-slate-800">{metrics.dnsLookupTime} ms</span>
                        </div>
                        <div className="flex justify-between items-center text-sm border-b border-slate-100 pb-2">
                          <span className="text-slate-500">TCP Connect Time</span>
                          <span className="font-semibold text-slate-800">{metrics.tcpConnectTime} ms</span>
                        </div>
                        <div className="flex justify-between items-center text-sm border-b border-slate-100 pb-2">
                          <span className="text-slate-500">Time to First Byte (TTFB)</span>
                          <span className="font-semibold text-slate-800">{metrics.ttfb} ms</span>
                        </div>
                        <div className="flex justify-between items-center text-sm border-b border-slate-100 pb-2">
                          <span className="text-slate-500">DOM Content Loaded</span>
                          <span className="font-semibold text-slate-800">{metrics.domContentLoaded} ms</span>
                        </div>
                        <div className="flex justify-between items-center text-sm pb-1">
                          <span className="text-slate-500 font-medium">Full Page Load Time</span>
                          <span className="font-bold text-indigo-600">{metrics.pageLoadTime} ms</span>
                        </div>
                      </div>
                    </div>
                    <div className="mt-4 pt-4 border-t border-slate-100 text-xs text-slate-400">
                      Extracted from window.performance timing metrics
                    </div>
                  </div>
                )}

                {/* Visual Snapshot Card */}
                {screenshot && (
                  <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-col">
                    <h3 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2">
                      <Camera className="w-5 h-5 text-indigo-500" />
                      Visual Page Snapshot
                    </h3>
                    <div className="flex-1 min-h-[200px] border border-slate-200 rounded-lg overflow-hidden relative bg-slate-50">
                      <img 
                        src={`data:image/jpeg;base64,${screenshot}`} 
                        alt="Audited Page Screenshot" 
                        className="w-full h-full object-cover max-h-[300px]"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5 gap-6">
              {categories.map((category, idx) => {
                const highPriorityCount = category.issues.filter(
                  (i) => i.severity === 'Critical' || i.severity === 'High'
                ).length;

                return (
                  <div
                    key={idx}
                    className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden h-full flex flex-col animate-fade-in"
                    style={{ animationDelay: `${idx * 100}ms` }}
                  >
                    <div className={`p-4 ${category.bgColor} border-b border-slate-100`}>
                      <div className="flex items-center gap-3">
                        <div className={`${category.iconColor}`}>{category.icon}</div>
                        <h3 className="font-semibold text-slate-900">{category.title}</h3>
                      </div>
                    </div>

                    <div className="flex-1 overflow-auto">
                      <ul className="divide-y divide-slate-100">
                        {category.issues.map((issue) => (
                          <li key={issue.id} className="p-4 hover:bg-slate-50 transition-colors">
                            <div className="flex items-start gap-3">
                              <div
                                className={`w-2 h-2 mt-2 rounded-full flex-shrink-0 ${severityColors[issue.severity].dot}`}
                              />
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-slate-900 truncate">
                                  {issue.title}
                                </p>
                                <p className="text-xs text-slate-500 mt-0.5">{issue.description}</p>
                              </div>
                              <span
                                className={`px-2 py-0.5 text-xs font-medium rounded-full flex-shrink-0 ${severityColors[issue.severity].badge}`}
                              >
                                {issue.severity}
                              </span>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div className="p-4 bg-slate-50 border-t border-slate-100">
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-600">
                          <span className="font-semibold text-slate-900">{category.issues.length}</span> issues
                        </span>
                        {highPriorityCount > 0 && (
                          <span className="text-red-600 font-medium">
                            {highPriorityCount} high priority
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-8 p-6 bg-gradient-to-r from-slate-800 to-slate-900 rounded-xl text-white">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <h3 className="text-lg font-semibold mb-1">Critical Issues Detected</h3>
                  <p className="text-slate-300 text-sm">
                    {criticalCount} critical and {highCount} high priority issues require immediate attention.
                  </p>
                </div>
                <button
                  onClick={() => setShowDetailed(true)}
                  className="px-6 py-3 bg-white text-slate-900 font-medium rounded-lg hover:bg-slate-100 transition-colors"
                >
                  View Detailed Report
                </button>
              </div>
            </div>
          </main>

          {showDetailed && (
            <div className="fixed inset-0 z-[100] bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
              <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[80vh] flex flex-col overflow-hidden animate-fade-in">
                <div className="p-6 border-b border-slate-200 flex items-center justify-between">
                  <h2 className="text-2xl font-bold text-slate-900">Detailed Audit Report</h2>
                  <button onClick={() => setShowDetailed(false)} className="text-slate-500 hover:text-slate-700">
                    ✕ Close
                  </button>
                </div>
                <div className="p-6 overflow-y-auto flex-1">
                  {categories.map((category, idx) => {
                    if (category.issues.length === 0) return null;
                    return (
                      <div key={idx} className="mb-8 last:mb-0">
                        <div className="flex items-center gap-2 mb-4">
                          <div className={category.iconColor}>{category.icon}</div>
                          <h3 className="text-lg font-bold text-slate-900">{category.title}</h3>
                        </div>
                        <ul className="space-y-4">
                          {category.issues.map(issue => (
                            <li key={issue.id} className="bg-slate-50 p-5 rounded-xl border border-slate-200">
                              <div className="flex items-center justify-between mb-2">
                                <span className="font-bold text-slate-900 text-base">{issue.title}</span>
                                <div className="flex items-center gap-2">
                                  <span className="px-2 py-0.5 text-xs font-semibold bg-indigo-100 text-indigo-700 rounded-full">
                                    Confidence: {issue.confidence}%
                                  </span>
                                  <span className={"px-2.5 py-0.5 text-xs font-semibold rounded-full " + severityColors[issue.severity].badge}>
                                    {issue.severity}
                                  </span>
                                </div>
                              </div>
                              <p className="text-sm text-slate-700 leading-relaxed mb-1">{issue.description}</p>
                              <p className="text-xs text-slate-500 mb-3"><span className="font-semibold">Detected at:</span> {issue.exactPageUrl}</p>
                              
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3 pt-3 border-t border-slate-100 text-xs">
                                <div>
                                  <p className="font-semibold text-slate-500 uppercase tracking-wider mb-1">Evidence / Proof</p>
                                  <pre className="bg-slate-100 p-2.5 rounded border border-slate-200 text-slate-800 overflow-x-auto font-mono whitespace-pre-wrap">
                                    {issue.evidence}
                                  </pre>
                                </div>
                                <div>
                                  <p className="font-semibold text-slate-500 uppercase tracking-wider mb-1">Reproduction Steps</p>
                                  <p className="text-slate-600 whitespace-pre-line bg-slate-100 p-2.5 rounded border border-slate-200">{issue.reproductionSteps}</p>
                                </div>
                              </div>

                              {(issue.consoleError || issue.networkLog || issue.domSelector || issue.apiResponse) && (
                                <div className="mt-3 pt-3 border-t border-slate-100 text-xs">
                                  <p className="font-semibold text-slate-500 uppercase tracking-wider mb-2">Telemetry Logs & Proof Details</p>
                                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                    {issue.consoleError && (
                                      <div>
                                        <p className="font-medium text-slate-600 mb-1">Console Logs / Runtime Stack</p>
                                        <pre className="bg-red-50/50 text-red-700 p-2.5 rounded border border-red-100 overflow-x-auto font-mono whitespace-pre-wrap">
                                          {issue.consoleError}
                                        </pre>
                                      </div>
                                    )}
                                    {issue.networkLog && (
                                      <div>
                                        <p className="font-medium text-slate-600 mb-1">Network Transmission Log</p>
                                        <pre className="bg-slate-100 p-2.5 rounded border border-slate-200 overflow-x-auto font-mono whitespace-pre-wrap">
                                          {issue.networkLog}
                                        </pre>
                                      </div>
                                    )}
                                    {issue.domSelector && (
                                      <div>
                                        <p className="font-medium text-slate-600 mb-1">DOM Selector / Element Code</p>
                                        <pre className="bg-blue-50/50 text-blue-700 p-2.5 rounded border border-blue-100 overflow-x-auto font-mono whitespace-pre-wrap">
                                          {issue.domSelector}
                                        </pre>
                                      </div>
                                    )}
                                    {issue.apiResponse && (
                                      <div>
                                        <p className="font-medium text-slate-600 mb-1">API Payload Response</p>
                                        <pre className="bg-slate-100 p-2.5 rounded border border-slate-200 overflow-x-auto font-mono whitespace-pre-wrap">
                                          {issue.apiResponse}
                                        </pre>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              )}
                              
                              <div className="mt-3 pt-3 border-t border-slate-100 text-xs">
                                <p className="font-semibold text-emerald-600 uppercase tracking-wider mb-1">Recommended Fix</p>
                                <p className="text-slate-700 bg-emerald-50/50 p-2.5 rounded border border-emerald-100">{issue.recommendedFix}</p>
                              </div>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                  
                  {/* Observations Section */}
                  {observations.length > 0 && (
                    <div className="mt-8 pt-8 border-t-2 border-slate-200 border-dashed">
                      <div className="flex items-center gap-2 mb-4">
                        <div className="text-amber-600">
                          <AlertCircle className="w-5 h-5" />
                        </div>
                        <h3 className="text-lg font-bold text-slate-900">Observations Requiring Manual Verification</h3>
                      </div>
                      <ul className="space-y-4">
                        {observations.map((issue, idx) => (
                          <li key={idx} className="bg-amber-50/10 p-5 rounded-xl border border-amber-200/50">
                            <div className="flex items-center justify-between mb-2">
                              <span className="font-bold text-slate-900 text-base">{issue.title}</span>
                              <div className="flex items-center gap-2">
                                <span className="px-2 py-0.5 text-xs font-semibold bg-amber-100 text-amber-700 rounded-full">
                                  Confidence: {issue.confidence}%
                                </span>
                                <span className={"px-2.5 py-0.5 text-xs font-semibold rounded-full " + severityColors[issue.severity].badge}>
                                  {issue.severity}
                                </span>
                              </div>
                            </div>
                            <p className="text-sm text-slate-700 leading-relaxed mb-1">{issue.description}</p>
                            <p className="text-xs text-slate-500 mb-3"><span className="font-semibold">Detected at:</span> {issue.exactPageUrl}</p>
                            
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3 pt-3 border-t border-amber-100/50 text-xs">
                              <div>
                                <p className="font-semibold text-amber-600/80 uppercase tracking-wider mb-1">Unverified Evidence</p>
                                <pre className="bg-amber-50/30 p-2.5 rounded border border-amber-200/30 text-slate-800 overflow-x-auto font-mono whitespace-pre-wrap">
                                  {issue.evidence}
                                </pre>
                              </div>
                              <div>
                                <p className="font-semibold text-amber-600/80 uppercase tracking-wider mb-1">Reproduction Steps</p>
                                <p className="text-slate-600 whitespace-pre-line bg-amber-50/30 p-2.5 rounded border border-amber-200/30">{issue.reproductionSteps}</p>
                              </div>
                            </div>

                            {(issue.consoleError || issue.networkLog || issue.domSelector || issue.apiResponse) && (
                              <div className="mt-3 pt-3 border-t border-amber-100/50 text-xs">
                                <p className="font-semibold text-amber-600/80 uppercase tracking-wider mb-2">Telemetry Logs & Proof Details</p>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                  {issue.consoleError && (
                                    <div>
                                      <p className="font-medium text-amber-700/80 mb-1">Console Logs / Runtime Stack</p>
                                      <pre className="bg-red-50/30 text-red-800 p-2.5 rounded border border-red-200/30 overflow-x-auto font-mono whitespace-pre-wrap">
                                        {issue.consoleError}
                                      </pre>
                                    </div>
                                  )}
                                  {issue.networkLog && (
                                    <div>
                                      <p className="font-medium text-amber-700/80 mb-1">Network Transmission Log</p>
                                      <pre className="bg-amber-50/20 p-2.5 rounded border border-amber-200/20 overflow-x-auto font-mono whitespace-pre-wrap">
                                        {issue.networkLog}
                                      </pre>
                                    </div>
                                  )}
                                  {issue.domSelector && (
                                    <div>
                                      <p className="font-medium text-amber-700/80 mb-1">DOM Selector / Element Code</p>
                                      <pre className="bg-blue-50/30 text-blue-800 p-2.5 rounded border border-blue-200/30 overflow-x-auto font-mono whitespace-pre-wrap">
                                        {issue.domSelector}
                                      </pre>
                                    </div>
                                  )}
                                  {issue.apiResponse && (
                                    <div>
                                      <p className="font-medium text-amber-700/80 mb-1">API Payload Response</p>
                                      <pre className="bg-amber-50/20 p-2.5 rounded border border-amber-200/20 overflow-x-auto font-mono whitespace-pre-wrap">
                                        {issue.apiResponse}
                                      </pre>
                                    </div>
                                  )}
                                </div>
                              </div>
                            )}
                            
                            <div className="mt-3 pt-3 border-t border-amber-100/50 text-xs">
                              <p className="font-semibold text-slate-600 uppercase tracking-wider mb-1">Suggested Review Steps</p>
                              <p className="text-slate-700 bg-slate-100/50 p-2.5 rounded border border-slate-200">{issue.recommendedFix}</p>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {totalIssues === 0 && observations.length === 0 && (
                    <div className="text-center text-slate-500 py-8">
                      No verified issues or observations were found during the audit!
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
