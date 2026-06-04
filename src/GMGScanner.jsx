import { useState, useRef, useCallback, useEffect } from "react";

// ── Technical Analysis ──────────────────────────────────────────────────────

function calcRSI(closes, period = 14) {
  if (closes.length < period + 2) return [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  const rsi = [];
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    rsi.push(100 - 100 / (1 + avgGain / (avgLoss || 1e-9)));
  }
  return rsi;
}

function ema(data, p) {
  const k = 2 / (p + 1);
  let v = data[0];
  return data.map((x, i) => (i === 0 ? v : (v = x * k + v * (1 - k))));
}

function calcMACDHist(closes, fast = 12, slow = 26, sig = 9) {
  if (closes.length < slow + sig + 2) return [];
  const fastE = ema(closes, fast);
  const slowE = ema(closes, slow);
  const macdLine = fastE.map((f, i) => f - slowE[i]).slice(slow - 1);
  if (macdLine.length < sig + 2) return [];
  const sigLine = ema(macdLine, sig);
  return macdLine.slice(sig - 1).map((m, i) => m - sigLine[i]);
}

function bullishDiv(prices, indicator, win = 8) {
  if (prices.length < win * 2 || indicator.length < win * 2) return false;
  const p = prices.slice(-win * 2), ind = indicator.slice(-win * 2);
  const h = win;
  return (
    Math.min(...p.slice(h)) < Math.min(...p.slice(0, h)) * 0.995 &&
    Math.min(...ind.slice(h)) > Math.min(...ind.slice(0, h)) * 1.005
  );
}

function bearishDiv(prices, indicator, win = 8) {
  if (prices.length < win * 2 || indicator.length < win * 2) return false;
  const p = prices.slice(-win * 2), ind = indicator.slice(-win * 2);
  const h = win;
  return (
    Math.max(...p.slice(h)) > Math.max(...p.slice(0, h)) * 1.005 &&
    Math.max(...ind.slice(h)) < Math.max(...ind.slice(0, h)) * 0.995
  );
}

// ── Binance API ─────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BINANCE = "https://api.binance.com/api/v3";

async function getTop200Pairs() {
  const r = await fetch(`${BINANCE}/ticker/24hr`);
  if (!r.ok) throw new Error("Failed to fetch pairs");
  const data = await r.json();
  return data
    .filter((t) => t.symbol.endsWith("USDT") && parseFloat(t.quoteVolume) > 0)
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, 200);
}

async function getKlines(symbol, interval, limit = 100) {
  const r = await fetch(
    `\( {BINANCE}/klines?symbol= \){symbol}&interval=\( {interval}&limit= \){limit}`
  );
  if (!r.ok) return null;
  const data = await r.json();
  return {
    closes: data.map((k) => parseFloat(k[4])),
    volumes: data.map((k) => parseFloat(k[5])),
  };
}

// ── Timeframes ──────────────────────────────────────────────────────────────

const TIMEFRAMES = [
  { label: "5m",  value: "5m" },
  { label: "15m", value: "15m" },
  { label: "30m", value: "30m" },
  { label: "1H",  value: "1h" },
  { label: "4H",  value: "4h" },
  { label: "1D",  value: "1d" },
];

// ── Component ───────────────────────────────────────────────────────────────

export default function GMGScanner() {
  const [selectedTF, setSelectedTF] = useState("4h");
  const [alerts, setAlerts] = useState([]);
  const [log, setLog] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState("ALL");
  const [countdown, setCountdown] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const stopRef = useRef(false);
  const alertsRef = useRef([]);
  const timerRef = useRef(null);
  const countRef = useRef(null);

  const addLog = useCallback((msg) => {
    setLog((l) =>
      [`[${new Date().toLocaleTimeString()}] ${msg}`, ...l].slice(0, 100)
    );
  }, []);

  const runScan = useCallback(async (tf) => {
    stopRef.current = false;
    setScanning(true);
    setAlerts([]);
    alertsRef.current = [];
    setProgress(0);
    const interval = tf || selectedTF;

    addLog(`جمع‌آوری ۲۰۰ جفت‌ارز برتر از Binance…`);
    let pairs = [];
    try {
      pairs = await getTop200Pairs();
    } catch (e) {
      addLog("⚠ خطا در دریافت لیست ارزها. اینترنت را بررسی کن.");
      setScanning(false);
      return;
    }
    setTotal(pairs.length);
    addLog(`${pairs.length} ارز یافت شد. اسکن روی تایم‌فریم ${interval}…`);

    for (let i = 0; i < pairs.length; i++) {
      if (stopRef.current) { addLog("اسکن متوقف شد."); break; }
      const p = pairs[i];
      const sym = p.symbol;
      setProgress(i + 1);

      try {
        const chart = await getKlines(sym, interval, 120);
        await sleep(80);
        if (!chart || chart.closes.length < 40) continue;

        const { closes, volumes } = chart;
        const rsi = calcRSI(closes);
        const macdH = calcMACDHist(closes);

        if (rsi.length < 16 || macdH.length < 16) continue;

        const minLen = Math.min(closes.length, rsi.length, macdH.length, volumes.length);
        const cl = closes.slice(-minLen);
        const rs = rsi.slice(-minLen);
        const mc = macdH.slice(-minLen);
        const vl = volumes.slice(-minLen);

        const isBull = bullishDiv(cl, rs) && bullishDiv(cl, mc) && bullishDiv(cl, vl);
        const isBear = bearishDiv(cl, rs) && bearishDiv(cl, mc) && bearishDiv(cl, vl);

        if (isBull || isBear) {
          const type = isBull ? "BULLISH" : "BEARISH";
          const price = parseFloat(p.lastPrice);
          const change = parseFloat(p.priceChangePercent);
          const alert = {
            id: `\( {sym}- \){interval}-\( {type}- \){Date.now()}`,
            symbol: sym.replace("USDT", ""),
            pair: sym,
            tf: interval.toUpperCase(),
            type,
            price,
            change,
            rsi: rs.at(-1)?.toFixed(1) ?? "–",
            vol24h: parseFloat(p.quoteVolume),
            time: new Date().toLocaleTimeString(),
          };
          alertsRef.current = [alert, ...alertsRef.current];
          setAlerts([...alertsRef.current]);
          addLog(`🔔 ${type}: ${sym} | ${interval.toUpperCase()} | RSI+MACD+VOL تایید شد`);
        }
      } catch { /* skip */ }
    }

    if (!stopRef.current)
      addLog(`✅ اسکن تمام شد. ${alertsRef.current.length} واگرایی یافت شد.`);
    setScanning(false);
  }, [selectedTF, addLog]);

  useEffect(() => {
    if (!autoRefresh) {
      clearInterval(timerRef.current);
      clearInterval(countRef.current);
      return;
    }
    setCountdown(60);
    countRef.current = setInterval(() => {
      setCountdown((c) => c <= 1 ? 60 : c - 1);
    }, 1000);
    timerRef.current = setInterval(() => {
      if (!stopRef.current) runScan();
    }, 60000);
    return () => {
      clearInterval(timerRef.current);
      clearInterval(countRef.current);
    };
  }, [autoRefresh, runScan]);

  const pct = total ? Math.round((progress / total) * 100) : 0;
  const bullCount = alerts.filter((a) => a.type === "BULLISH").length;
  const bearCount = alerts.filter((a) => a.type === "BEARISH").length;
  const visible = filter === "ALL" ? alerts : alerts.filter((a) => a.type === filter);

  const fmtVol = (v) => {
    if (v >= 1e9) return `\[ {(v / 1e9).toFixed(1)}B`;
    if (v >= 1e6) return ` \]{(v / 1e6).toFixed(1)}M`;
    return `$${(v / 1e3).toFixed(0)}K`;
  };

  return (
    <div style={{ minHeight: "100vh", background: "#03080d", color: "#b8ffcc", fontFamily: "'Courier New', Courier, monospace", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "14px 16px 10px", borderBottom: "1px solid #00ff4128" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: "bold", color: "#00ff9f", letterSpacing: 4 }}>◈ GMG SCANNER</div>
            <div style={{ fontSize: 8, color: "#00ff9f55", letterSpacing: 2, marginTop: 1 }}>RSI · MACD · VOLUME · BINANCE · TOP 200</div>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button onClick={() => setAutoRefresh(a => !a)} style={{ background: autoRefresh ? "#00ff9f18" : "#ffffff08", border: `1px solid ${autoRefresh ? "#00ff9f55" : "#ffffff22"}`, color: autoRefresh ? "#00ff9f" : "#ffffff44", padding: "5px 10px", cursor: "pointer", fontSize: 9 }}>
              {autoRefresh ? `🔄 ${countdown}s` : "🔄 OFF"}
            </button>
            <button onClick={scanning ? () => { stopRef.current = true; } : () => runScan()} style={{ background: scanning ? "#ff003318" : "#00ff9f18", border: `1px solid ${scanning ? "#ff0033" : "#00ff9f"}`, color: scanning ? "#ff4455" : "#00ff9f", padding: "7px 14px", cursor: "pointer", fontSize: 10, fontWeight: "bold" }}>
              {scanning ? "⬛ STOP" : "▶ SCAN"}
            </button>
          </div>
        </div>
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          {TIMEFRAMES.map((tf) => (
            <button key={tf.value} onClick={() => { setSelectedTF(tf.value); if (!scanning) runScan(tf.value); }} style={{ background: selectedTF === tf.value ? "#00ff9f22" : "transparent", border: `1px solid ${selectedTF === tf.value ? "#00ff9f" : "#00ff9f33"}`, color: selectedTF === tf.value ? "#00ff9f" : "#00ff9f55", padding: "4px 10px", cursor: "pointer", fontSize: 10 }}>
              {tf.label}
            </button>
          ))}
        </div>
      </div>

      {(scanning || progress > 0) && (
        <div style={{ padding: "6px 16px 0" }}>
          <div style={{ height: 2, background: "#0a1a0a" }}>
            <div style={{ height: "100%", width: `${pct}%`, background: "linear-gradient(90deg,#00ff9f,#00ccff)" }} />
          </div>
        </div>
      )}

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <div style={{ flex: 1, padding: "10px 14px", overflowY: "auto" }}>
          {/* بقیه کد UI */}
          {visible.length === 0 ? (
            <div style={{ textAlign: "center", padding: "40px 20px", color: "#00ff9f44" }}>
              دکمه SCAN را بزن
            </div>
          ) : (
            // لیست آلارم‌ها
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {visible.map(a => { /* ... */ return <div key={a.id}>...</div> })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
