// index.js
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as wait } from 'timers/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const JUP_API_KEY = process.env.JUP_API_KEY;
const JUP_ULTRA_BASE = "https://api.jup.ag/ultra/v1";
const HELIUS_KEYS = [
    process.env.RPC_URL,
    process.env.RPC_URL2,
    process.env.RPC_URL3
].filter(Boolean);

const HELIUS_URLS = HELIUS_KEYS.map(key => `https://api.helius.xyz/v0/transactions/?api-key=${key}`);

const ALCHEMY_KEYS = [
    process.env.BLANC_URL,
    process.env.BLANC_URL2,
    process.env.BLANC_URL3
].filter(Boolean);
const ALCHEMY_URLS = ALCHEMY_KEYS.map(key => `https://solana-mainnet.g.alchemy.com/v2/${key}`);

const sleep = ms => wait(ms);

let isRunning = false;
let activeProgress = new Map();
let results = [];
let nextAddressIndex = 0;
let addresses = [];

async function getJupiterBalances(address) {
    return null;
}

async function getSignaturesFromAlchemy(address, alchemyUrl, year) {
    const startYear = year === '2025' ? 1735689600 : 1704067200;
    const endYear = year === '2025' ? 1767225599 : 1735689599;
    let signatures = [];
    let before = null;
    try {
        const fetchBatch = async (beforeSig) => {
            const payload = { 
                jsonrpc: "2.0", 
                id: 1, 
                method: "getSignaturesForAddress", 
                params: [address, { limit: 1000, before: beforeSig }] 
            };
            const resp = await fetch(alchemyUrl, { 
                method: "POST", 
                headers: { "Content-Type": "application/json" }, 
                body: JSON.stringify(payload),
                keepalive: true
            });
            const data = await resp.json();
            return data.result || [];
        };

        // Fetch first batch
        let batch = await fetchBatch(null);
        while (batch.length > 0) {
            let inRange = false;
            for (const sig of batch) {
                if (sig.blockTime >= startYear && sig.blockTime <= endYear) {
                    signatures.push(sig.signature);
                    inRange = true;
                } else if (sig.blockTime < startYear) {
                    return signatures; // Out of range, older than start
                }
            }
            
            // If the whole batch was newer than our range, we keep going
            // If we found some in range, we continue
            // If we hit older, we already returned.
            const lastSig = batch[batch.length - 1].signature;
            batch = await fetchBatch(lastSig);
            if (!isRunning) break;
        }
    } catch (err) {}
    return signatures;
}

function calculateJupAllocation(volume) {
    if (volume >= 10000000) return 20000;
    if (volume >= 5000000) return 12000;
    if (volume >= 1000000) return 5000;
    if (volume >= 500000) return 2500;
    if (volume >= 100000) return 1000;
    if (volume >= 10000) return 200;
    if (volume >= 1000) return 50;
    if (volume >= 500) return 25;
    return 0;
}

async function analyzeSignaturesHelius(signatures, address, apiKey, onProgress) {
    let totalJupSwaps = 0;
    let totalVolumeUSD = 0;
    const jupProgramIds = ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB", "DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M", "j1o2qRpjcyUwEvwtcfhEQefh773ZgjxcVRry7LDqg5X"];
    const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const usdtMint = "Es9vMFrzaDC6is695G2C48LswSt53n4n8zVLLt39G75";
    const concurrency = 25;
    const batches = [];
    for (let i = 0; i < signatures.length; i += 100) batches.push(signatures.slice(i, i + 100));

    const processBatch = async (batch, startIdx) => {
        const url = apiKey.startsWith('http') ? apiKey : `https://api.helius.xyz/v0/transactions/?api-key=${apiKey}`;
        try {
            const resp = await fetch(url, { 
                method: "POST", 
                headers: { "Content-Type": "application/json" }, 
                body: JSON.stringify({ transactions: batch }),
                keepalive: true
            });
            if (!resp.ok) {
                if (resp.status === 429) { return processBatch(batch, startIdx); }
                return;
            }
            const txs = await resp.json();
            for (const tx of txs) {
                const txString = JSON.stringify(tx);
                const isJup = tx.source === "JUPITER" || jupProgramIds.some(id => txString.includes(id)) || (tx.instructions && tx.instructions.some(ix => jupProgramIds.includes(ix.programId)));
                if (isJup) {
                    totalJupSwaps++;
                    if (tx.events && tx.events.swap) {
                        const swaps = Array.isArray(tx.events.swap) ? tx.events.swap : [tx.events.swap];
                        swaps.forEach(swap => {
                            let foundUSD = false;
                            const tokens = [...(swap.tokenInputs || []), ...(swap.tokenOutputs || [])];
                            tokens.forEach(t => {
                                if (t.mint === usdcMint || t.mint === usdtMint) {
                                    const amount = parseFloat(t.rawAmount || t.tokenAmount || "0");
                                    if (!isNaN(amount)) {
                                        totalVolumeUSD += t.rawAmount ? amount / 1e6 : amount;
                                        foundUSD = true;
                                    }
                                }
                            });
                            if (!foundUSD) {
                                const inputAmount = swap.nativeInput ? parseFloat(swap.nativeInput.amount) : 0;
                                const outputAmount = swap.nativeOutput ? parseFloat(swap.nativeOutput.amount) : 0;
                                if (!isNaN(inputAmount) && inputAmount > 0) totalVolumeUSD += (inputAmount / 1e9) * 155;
                                else if (!isNaN(outputAmount) && outputAmount > 0) totalVolumeUSD += (outputAmount / 1e9) * 155;
                            }
                        });
                    } else if (tx.tokenTransfers) {
                        tx.tokenTransfers.forEach(tt => {
                            if (tt.mint === usdcMint || tt.mint === usdtMint) {
                                const amount = parseFloat(tt.tokenAmount || "0");
                                if (!isNaN(amount) && (tt.fromUserAccount === address || tt.toUserAccount === address)) totalVolumeUSD += amount;
                            }
                        });
                    }
                }
            }
            if (onProgress) onProgress(totalJupSwaps, Math.min(startIdx + 100, signatures.length), totalVolumeUSD);
        } catch (err) {}
    };

    for (let i = 0; i < batches.length; i += concurrency) {
        if (!isRunning) break;
        await Promise.all(batches.slice(i, i + concurrency).map((b, idx) => processBatch(b, i * 100 + idx * 100)));
    }
    return { count: totalJupSwaps, volume: totalVolumeUSD, totalAnalyzed: signatures.length };
}

async function checkRpcHealth(url, method = "getHealth") {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: [] }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        return resp.ok;
    } catch (e) {
        return false;
    }
}

app.get('/health', async (req, res) => {
    const heliusStatus = await Promise.all(HELIUS_URLS.map(url => checkRpcHealth(url, "getAsset")));
    const alchemyStatus = await Promise.all(ALCHEMY_URLS.map(url => checkRpcHealth(url)));
    res.json({
        helius: heliusStatus.filter(Boolean).length,
        alchemy: alchemyStatus.filter(Boolean).length
    });
});

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Jupiter Analyzer</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        body { background-color: #0f172a; color: #f8fafc; font-family: 'Inter', sans-serif; }
        .glass { background: rgba(30, 41, 59, 0.7); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.1); }
        .progress-bar { transition: width 0.3s ease-in-out; }
        .break-all { word-break: break-all; }
        #toast { position: fixed; top: -100px; left: 50%; transform: translateX(-50%); background: #10b981; color: white; padding: 12px 24px; border-radius: 12px; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1); transition: top 0.5s ease; z-index: 1000; }
        #toast.show { top: 20px; }
    </style>
</head>
<body class="p-4 md:p-8">
    <div id="toast">Analysis Completed! ✅</div>
    <div class="max-w-4xl mx-auto overflow-hidden">
        <header class="mb-8 text-center">
            <h1 class="text-4xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-500">Jupiter Analyzer</h1>
            <p id="subHeader" class="text-slate-400 mt-2">Solana Wallet Swap & Volume Analysis</p>
            <div id="connectionStatus" class="mt-4 flex justify-center gap-3"></div>
        </header>
        <div class="glass rounded-2xl p-4 md:p-6 mb-8">
            <div class="flex justify-between items-center mb-4">
                <label class="text-sm font-medium">Wallet Addresses</label>
                <select id="yearSelect" class="bg-slate-900 border border-slate-700 rounded-lg px-3 py-1 text-sm outline-none">
                    <option value="2024">Year 2024</option>
                    <option value="2025" selected>Year 2025</option>
                </select>
            </div>
            <textarea id="addresses" class="w-full h-40 bg-slate-900 border border-slate-700 rounded-xl p-4 focus:ring-2 focus:ring-blue-500 outline-none text-sm" placeholder="Enter Solana addresses..."></textarea>
            <div class="flex flex-col md:flex-row gap-4 mt-4">
                <button onclick="start()" id="startBtn" class="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-xl transition-all">Start Analysis</button>
                <button onclick="stop()" id="stopBtn" class="flex-1 bg-red-600 hover:bg-red-700 text-white font-bold py-3 rounded-xl transition-all opacity-50 cursor-not-allowed" disabled>Stop</button>
            </div>
        </div>
        <div id="status" class="mb-8 hidden">
            <div class="flex justify-between mb-2">
                <span id="progressText" class="text-xs md:text-sm font-medium">Progress: 0%</span>
                <span id="activeCount" class="text-xs md:text-sm font-medium">Active: 0</span>
            </div>
            <div class="w-full bg-slate-800 rounded-full h-3 overflow-hidden">
                <div id="progressBar" class="progress-bar bg-gradient-to-r from-blue-500 to-purple-600 h-full w-0"></div>
            </div>
        </div>
        <div id="activeWorkers" class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8"></div>
        <div class="glass rounded-2xl p-4 md:p-6">
            <h2 class="text-lg md:text-xl font-bold mb-4 flex justify-between items-center">Recent Results <span id="totalResults" class="text-sm font-normal text-slate-400">Total: 0</span></h2>
            <div id="resultsList" class="space-y-4"></div>
        </div>
    </div>
    <script>
        const socket = io();
        
        async function updateHealth() {
            try {
                const resp = await fetch('/health');
                const data = await resp.json();
                const connStatus = document.getElementById('connectionStatus');
                if (connStatus) {
                    connStatus.innerHTML = '<div class="flex items-center gap-2 px-3 py-1 bg-slate-800/50 rounded-full border border-blue-500/30"><span class="w-2 h-2 rounded-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.5)]"></span><span class="text-[10px] font-bold text-blue-400 uppercase tracking-wider">Helius: ' + data.helius + ' Online</span></div><div class="flex items-center gap-2 px-3 py-1 bg-slate-800/50 rounded-full border border-purple-500/30"><span class="w-2 h-2 rounded-full bg-purple-500 shadow-[0_0_8px_rgba(168,85,247,0.5)]"></span><span class="text-[10px] font-bold text-purple-400 uppercase tracking-wider">Alchemy: ' + data.alchemy + ' Online</span></div>';
                }
            } catch (e) {}
        }
        updateHealth();
        setInterval(updateHealth, 30000);

        const calculateJupAllocation = (v) => {
            if (v >= 1e7) return 20000; if (v >= 5e6) return 12000; if (v >= 1e6) return 5000; if (v >= 5e5) return 2500;
            if (v >= 1e5) return 1000; if (v >= 1e4) return 200; if (v >= 1e3) return 50; if (v >= 500) return 25; return 0;
        };
        function start() {
            const list = document.getElementById('addresses').value;
            const year = document.getElementById('yearSelect').value;
            if (!list.trim()) return;
            document.getElementById('subHeader').innerText = 'Analysis for Year ' + year;
            socket.emit('start', { list, year });
            document.getElementById('status').classList.remove('hidden');
            document.getElementById('startBtn').disabled = true; document.getElementById('startBtn').classList.add('opacity-50');
            document.getElementById('stopBtn').disabled = false; document.getElementById('stopBtn').classList.remove('opacity-50', 'cursor-not-allowed');
        }
        function stop() {
            socket.emit('stop');
            document.getElementById('stopBtn').disabled = true; document.getElementById('stopBtn').classList.add('opacity-50', 'cursor-not-allowed');
            document.getElementById('startBtn').disabled = false; document.getElementById('startBtn').classList.remove('opacity-50');
        }
        socket.on('update', (data) => {
            const { total, current, active, results, providers } = data;
            
            const percent = total > 0 ? (current / total) * 100 : 0;
            document.getElementById('progressBar').style.width = percent + '%';
            document.getElementById('progressText').innerText = 'Progress: ' + Math.round(percent) + '% (' + current + '/' + total + ')';
            document.getElementById('activeCount').innerText = 'Active: ' + active.length;
            document.getElementById('totalResults').innerText = 'Total: ' + results.length;
            document.getElementById('activeWorkers').innerHTML = active.map(w => {
                const jup = calculateJupAllocation(w.vol);
                return \`
                <div class="glass p-3 rounded-xl border-l-4 border-blue-500">
                    <div class="text-[10px] font-mono text-blue-400 break-all">\${w.address}</div>
                    <div class="flex justify-between mt-1 items-center">
                        <span class="text-[10px] uppercase font-bold text-slate-400">\${w.stage}</span>
                        <span class="text-[10px] text-slate-500">\${w.tx}/\${w.total || '?'} tx</span>
                    </div>
                    <div class="flex flex-col mt-1">
                        <div class="text-base font-bold text-white">$\${w.vol.toLocaleString(undefined, {maximumFractionDigits:2})}</div>
                        \${jup > 0 ? \`<div class="text-xs font-bold text-green-400">\${jup.toLocaleString()} JUP</div>\` : ''}
                    </div>
                </div>\`;
            }).join('');
            document.getElementById('resultsList').innerHTML = results.slice(0, 20).map(r => {
                const jup = calculateJupAllocation(r.volume);
                return \`
                <div class="p-3 bg-slate-900/50 rounded-xl border border-slate-800">
                    <div class="flex justify-between items-start gap-2">
                        <span class="text-[10px] font-mono text-slate-300 break-all flex-1">\${r.address}</span>
                        <div class="flex flex-col items-end">
                            <span class="bg-blue-900/30 text-blue-400 text-[10px] px-2 py-1 rounded-full font-bold">$\${r.volume.toLocaleString(undefined, {maximumFractionDigits:2})}</span>
                            \${jup > 0 ? \`<span class="text-[10px] font-bold text-green-400 mt-1">\${jup.toLocaleString()} JUP</span>\` : ''}
                        </div>
                    </div>
                </div>\`;
            }).join('');
        });
        socket.on('done', () => {
            stop();
            const toast = document.getElementById('toast');
            toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 2000);
        });
    </script>
</body>
</html>
    `);
});

io.on('connection', (socket) => {
    socket.on('start', async (data) => {
        if (isRunning) return;
        const { list, year } = data;
        isRunning = true;
        addresses = list.split('\n').map(s => s.trim()).filter(s => s.length >= 32);
        results = [];
        activeProgress.clear();
        nextAddressIndex = 0;
        const broadcast = () => socket.emit('update', { 
            total: addresses.length, 
            current: results.length, 
            active: Array.from(activeProgress.entries()).map(([addr, val]) => ({ address: addr, ...val })), 
            results,
            providers: {
                helius: HELIUS_KEYS.length,
                alchemy: ALCHEMY_KEYS.length
            }
        });
        const timer = setInterval(broadcast, 500);
        const workers = (HELIUS_KEYS.length > 0 ? HELIUS_KEYS : []).map(async (heliusKey, idx) => {
            const alchemyUrl = ALCHEMY_URLS[idx % ALCHEMY_URLS.length];
            while (isRunning && nextAddressIndex < addresses.length) {
                const addr = addresses[nextAddressIndex++];
                activeProgress.set(addr, { stage: "Fetching", tx: 0, vol: 0 });
                try {
                    const sigs = await getSignaturesFromAlchemy(addr, alchemyUrl, year);
                    if (!isRunning) break;
                    if (sigs.length === 0) results.push({ address: addr, usage: 0, volume: 0, totalAnalyzed: 0 });
                    else {
                        activeProgress.set(addr, { stage: "Analyzing", tx: 0, total: sigs.length, vol: 0 });
                        const d = await analyzeSignaturesHelius(sigs, addr, heliusKey, (c, curr, v) => {
                            if (isRunning) activeProgress.set(addr, { stage: "Analyzing", tx: curr, total: sigs.length, vol: v });
                        });
                        if (isRunning) results.push({ address: addr, usage: d.count, volume: d.volume, totalAnalyzed: d.totalAnalyzed });
                    }
                } catch (e) { 
                    if (isRunning) results.push({ address: addr, usage: 0, volume: 0, totalAnalyzed: 0, error: true }); 
                }
                activeProgress.delete(addr);
            }
        });
        await Promise.all(workers);
        clearInterval(timer); broadcast(); socket.emit('done'); isRunning = false;
    });
    socket.on('stop', () => isRunning = false);
});
httpServer.listen(5000, '0.0.0.0', () => console.log('Server running on port 5000'));
