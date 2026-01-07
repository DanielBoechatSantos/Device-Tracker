import '@whiskeysockets/baileys';
import { WASocket, proto } from '@whiskeysockets/baileys';
import { pino } from 'pino';

const logger = pino({
    level: process.argv.includes('--debug') ? 'debug' : 'silent'
});

export type ProbeMethod = 'delete' | 'reaction';

/**
 * Logger utility para monitoramento via terminal
 */
class TrackerLogger {
    private isDebugMode: boolean;

    constructor(debugMode: boolean = false) {
        this.isDebugMode = debugMode;
    }

    setDebugMode(enabled: boolean) {
        this.isDebugMode = enabled;
    }

    debug(...args: any[]) {
        if (this.isDebugMode) console.log(...args);
    }

    info(...args: any[]) {
        console.log(...args);
    }

    formatDeviceState(jid: string, rtt: number, avgRtt: number, median: number, threshold: number, state: string) {
        const stateColor = state === 'Online' ? '🟢' : state === 'Standby' ? '🟡' : '🔴';
        const timestamp = new Date().toLocaleTimeString();
        const boxWidth = 62;

        const header = `${stateColor} Status Update - ${timestamp}`;
        console.log(`\n╔════════════════════════════════════════════════════════════════╗`);
        console.log(`║ ${header.padEnd(boxWidth)} ║`);
        console.log(`╠════════════════════════════════════════════════════════════════╣`);
        console.log(`║ JID: ${jid.padEnd(boxWidth - 5)} ║`);
        console.log(`║ Status: ${state.padEnd(boxWidth - 8)} ║`);
        console.log(`║ RTT: ${String(rtt + 'ms').padEnd(boxWidth - 5)} ║`);
        console.log(`║ Threshold: ${String(threshold.toFixed(0) + 'ms').padEnd(boxWidth - 11)} ║`);
        console.log(`╚════════════════════════════════════════════════════════════════╝\n`);
    }
}

const trackerLogger = new TrackerLogger();

interface DeviceMetrics {
    rttHistory: number[];
    recentRtts: number[];
    state: string;
    lastRtt: number;
    lastUpdate: number;
}

export class WhatsAppTracker {
    private sock: WASocket;
    private targetJid: string;
    private trackedJids: Set<string> = new Set();
    private isTracking: boolean = false;
    private deviceMetrics: Map<string, DeviceMetrics> = new Map();
    private globalRttHistory: number[] = [];
    private probeStartTimes: Map<string, number> = new Map();
    private probeTimeouts: Map<string, NodeJS.Timeout> = new Map();
    private lastPresence: string | null = null;
    private probeMethod: ProbeMethod = 'delete';
    public onUpdate?: (data: any) => void;

    constructor(sock: WASocket, targetJid: string, debugMode: boolean = false) {
        this.sock = sock;
        this.targetJid = targetJid;
        this.trackedJids.add(targetJid);
        trackerLogger.setDebugMode(debugMode);
    }

    public setProbeMethod(method: ProbeMethod) {
        this.probeMethod = method;
    }

    public async startTracking() {
        if (this.isTracking) return;
        this.isTracking = true;

        // Listener de mensagens/recibos
        this.sock.ev.on('messages.update', (updates) => {
            for (const update of updates) {
                if (update.key.remoteJid && this.trackedJids.has(update.key.remoteJid) && update.key.fromMe) {
                    this.analyzeUpdate(update);
                }
            }
        });

        // Listener de recibos brutos (incluindo 'inactive')
        this.sock.ws.on('CB:receipt', (node: any) => {
            this.handleRawReceipt(node);
        });

        // Presença
        this.sock.ev.on('presence.update', (update) => {
            if (update.presences) {
                for (const [jid, presenceData] of Object.entries(update.presences)) {
                    if (presenceData?.lastKnownPresence) {
                        this.trackedJids.add(jid);
                        this.lastPresence = presenceData.lastKnownPresence;
                        break;
                    }
                }
            }
        });

        try {
            await this.sock.presenceSubscribe(this.targetJid);
        } catch (err) {
            trackerLogger.debug('[PRESENCE] Erro ao subscrever');
        }

        this.probeLoop();
    }

    private async probeLoop() {
        while (this.isTracking) {
            try {
                await this.sendProbe();
            } catch (err) {
                logger.error(err, 'Erro ao enviar probe');
            }
            
            // --- PROTEÇÃO ANTI-BAN: Jitter Aleatório ---
            // Intervalo varia entre 10 e 30 segundos para parecer humano
            const delay = Math.floor(Math.random() * 20000) + 10000;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    private async sendProbe() {
        const startTime = Date.now();
        const randomMsgId = 'TRACKER_' + Math.random().toString(36).substring(2, 15).toUpperCase();
        
        let message: any;
        if (this.probeMethod === 'delete') {
            message = { delete: { remoteJid: this.targetJid, fromMe: true, id: randomMsgId } };
        } else {
            message = { react: { text: '✨', key: { remoteJid: this.targetJid, fromMe: false, id: randomMsgId } } };
        }

        const result = await this.sock.sendMessage(this.targetJid, message);
        if (result?.key?.id) {
            this.probeStartTimes.set(result.key.id, startTime);
            const timeoutId = setTimeout(() => {
                if (this.probeStartTimes.has(result.key.id!)) {
                    this.markDeviceOffline(result.key.remoteJid!, 10000);
                    this.probeStartTimes.delete(result.key.id!);
                }
            }, 10000);
            this.probeTimeouts.set(result.key.id, timeoutId);
        }
    }

    private handleRawReceipt(node: any) {
        const { attrs } = node;
        if (attrs.type === 'inactive' || attrs.type === 'delivery') {
            const baseNumber = attrs.from.split('@')[0].split(':')[0];
            const isTracked = this.trackedJids.has(attrs.from) || this.trackedJids.has(`${baseNumber}@s.whatsapp.net`);
            if (isTracked) this.processAck(attrs.id, attrs.from, attrs.type);
        }
    }

    private processAck(msgId: string, fromJid: string, type: string) {
        const startTime = this.probeStartTimes.get(msgId);
        if (startTime) {
            const rtt = Date.now() - startTime;
            const timeoutId = this.probeTimeouts.get(msgId);
            if (timeoutId) clearTimeout(timeoutId);
            this.probeStartTimes.delete(msgId);
            this.addMeasurementForDevice(fromJid, rtt);
        }
    }

    private analyzeUpdate(update: any) {
        if (update.update.status === 3) { // DELIVERY_ACK
            this.processAck(update.key.id, update.key.remoteJid, 'delivery');
        }
    }

    private markDeviceOffline(jid: string, timeout: number) {
        if (!this.deviceMetrics.has(jid)) {
            this.deviceMetrics.set(jid, { rttHistory: [], recentRtts: [], state: 'OFFLINE', lastRtt: timeout, lastUpdate: Date.now() });
        } else {
            const m = this.deviceMetrics.get(jid)!;
            m.state = 'OFFLINE';
            m.lastUpdate = Date.now();
        }
        this.sendUpdate();
    }

    private addMeasurementForDevice(jid: string, rtt: number) {
        if (!this.deviceMetrics.has(jid)) {
            this.deviceMetrics.set(jid, { rttHistory: [], recentRtts: [], state: 'Calibrando...', lastRtt: rtt, lastUpdate: Date.now() });
        }
        const m = this.deviceMetrics.get(jid)!;
        m.recentRtts.push(rtt);
        if (m.recentRtts.length > 3) m.recentRtts.shift();
        this.globalRttHistory.push(rtt);
        if (this.globalRttHistory.length > 2000) this.globalRttHistory.shift();
        m.lastRtt = rtt;
        m.lastUpdate = Date.now();
        this.determineDeviceState(jid);
        this.sendUpdate();
    }

    private determineDeviceState(jid: string) {
        const m = this.deviceMetrics.get(jid)!;
        if (this.globalRttHistory.length < 3) return;

        const sorted = [...this.globalRttHistory].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const threshold = median * 0.9;
        const movingAvg = m.recentRtts.reduce((a, b) => a + b, 0) / m.recentRtts.length;

        m.state = movingAvg < threshold ? 'Online' : 'Standby';
        trackerLogger.formatDeviceState(jid, m.lastRtt, movingAvg, median, threshold, m.state);
    }

    private sendUpdate() {
        const devices = Array.from(this.deviceMetrics.entries()).map(([jid, m]) => ({
            jid, state: m.state, rtt: m.lastRtt
        }));
        if (this.onUpdate) this.onUpdate({ devices, presence: this.lastPresence });
    }

    public async getProfilePicture() {
        try { return await this.sock.profilePictureUrl(this.targetJid, 'image'); } catch { return null; }
    }

    public stopTracking() {
        this.isTracking = false;
        for (const t of this.probeTimeouts.values()) clearTimeout(t);
        this.probeTimeouts.clear();
        this.probeStartTimes.clear();
    }
}