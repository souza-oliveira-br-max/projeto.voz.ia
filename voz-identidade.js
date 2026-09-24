// ============================================================
// voz-identidade.js — Reconhecimento de Locutor (10 perfis)
// projetovozia · Arion
// ============================================================
// Distingue até 10 vozes nomeadas + categoriza automaticamente
// por gênero/idade (homem, mulher, criança, desconhecido).
//
// Uso básico:
//   const voz = new VozIdentidade({ debug: true });
//   await voz.iniciar();
//   await voz.registrar('Souza', 8);   // 8 segundos falando
//   const r = await voz.identificar(); // { nome, categoria, similaridade, confianca }
// ============================================================

class VozIdentidade {
    constructor(opcoes = {}) {
        // ---- Áudio ----
        this.sampleRate = 16000;
        this.frameSize = 400;       // 25 ms @ 16 kHz
        this.hopSize = 160;         // 10 ms
        this.fftSize = 512;
        this.melFiltros = 26;
        this.mfccCoefs = 12;        // C1..C12 (C0 = energia, redundante)

        // ---- Reconhecimento ----
        this.limiarSimilaridade = opcoes.limiarSimilaridade || 0.82;
        this.energiaMinima = opcoes.energiaMinima || 0.008;
        this.zcrMaximo = opcoes.zcrMaximo || 0.45;
        this.maxPerfis = 10;

        // ---- Faixas de pitch (Hz) para categorização ----
        this.faixas = {
            crianca: { min: 240, max: 500 },
            mulher:  { min: 165, max: 255 },
            homem:   { min: 70,  max: 180 }
        };

        // ---- Estado ----
        this.audioContext = null;
        this.stream = null;
        this.analyser = null;
        this.rodando = false;
        this.prefixo = 'arion:voz:';
        this.debug = opcoes.debug || false;

        // ---- Cache ----
        this._hamming = null;
        this._filtrosMel = null;

        // ---- Categorias conhecidas ----
        this.CATEGORIAS = ['souza', 'mulher', 'crianca', 'homem', 'desconhecido'];
    }

    // ============================================================
    // INICIALIZAÇÃO
    // ============================================================
    async iniciar() {
        if (this.audioContext) return true;
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: this.sampleRate,
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                    channelCount: 1
                }
            });

            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: this.sampleRate
            });

            const source = this.audioContext.createMediaStreamSource(this.stream);
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 2048;
            this.analyser.smoothingTimeConstant = 0;
            source.connect(this.analyser);

            // Pré-computa janela e filtros
            this._hamming = this._criarHamming(this.frameSize);
            this._filtrosMel = this._criarFiltrosMel();

            if (this.debug) console.log('🎤 VozIdentidade pronta @', this.audioContext.sampleRate, 'Hz');
            return true;
        } catch (e) {
            console.error('❌ VozIdentidade:', e);
            return false;
        }
    }

    parar() {
        this.rodando = false;
        if (this.stream) {
            this.stream.getTracks().forEach(t => t.stop());
            this.stream = null;
        }
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
    }

    // ============================================================
    // DPS — Blocos de processamento (cacheados)
    // ============================================================
    _criarHamming(n) {
        const w = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            w[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (n - 1));
        }
        return w;
    }

    _criarFiltrosMel() {
        const N = this.fftSize / 2 + 1;
        const fMin = 80, fMax = 4000;
        const melMin = 2595 * Math.log10(1 + fMin / 700);
        const melMax = 2595 * Math.log10(1 + fMax / 700);

        const pontos = [];
        for (let i = 0; i <= this.melFiltros + 1; i++) {
            const mel = melMin + (melMax - melMin) * i / (this.melFiltros + 1);
            pontos.push(700 * (Math.pow(10, mel / 2595) - 1));
        }

        const filtros = [];
        for (let m = 0; m < this.melFiltros; m++) {
            const f = new Float32Array(N);
            const f0 = pontos[m], f1 = pontos[m + 1], f2 = pontos[m + 2];
            for (let k = 0; k < N; k++) {
                const freq = k * this.sampleRate / this.fftSize;
                if (freq >= f0 && freq <= f1) f[k] = (freq - f0) / (f1 - f0);
                else if (freq > f1 && freq <= f2) f[k] = (f2 - freq) / (f2 - f1);
            }
            filtros.push(f);
        }
        return filtros;
    }

    // ============================================================
    // FFT — Cooley-Tukey radix-2 iterativa
    // ============================================================
    _fft(re, im) {
        const n = re.length;
        for (let i = 1, j = 0; i < n; i++) {
            let bit = n >> 1;
            for (; j & bit; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                [re[i], re[j]] = [re[j], re[i]];
                [im[i], im[j]] = [im[j], im[i]];
            }
        }
        for (let len = 2; len <= n; len <<= 1) {
            const ang = -2 * Math.PI / len;
            const wRe = Math.cos(ang), wIm = Math.sin(ang);
            for (let i = 0; i < n; i += len) {
                let cRe = 1, cIm = 0;
                const half = len >> 1;
                for (let j = 0; j < half; j++) {
                    const uRe = re[i + j], uIm = im[i + j];
                    const vRe = re[i + j + half] * cRe - im[i + j + half] * cIm;
                    const vIm = re[i + j + half] * cIm + im[i + j + half] * cRe;
                    re[i + j] = uRe + vRe;
                    im[i + j] = uIm + vIm;
                    re[i + j + half] = uRe - vRe;
                    im[i + j + half] = uIm - vIm;
                    const nRe = cRe * wRe - cIm * wIm;
                    cIm = cRe * wIm + cIm * wRe;
                    cRe = nRe;
                }
            }
        }
    }

    // ============================================================
    // FEATURES POR FRAME
    // ============================================================
    _energia(frame) {
        let s = 0;
        for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
        return Math.sqrt(s / frame.length);
    }

    _zcr(frame) {
        let z = 0;
        for (let i = 1; i < frame.length; i++) {
            if ((frame[i - 1] >= 0) !== (frame[i] >= 0)) z++;
        }
        return z / frame.length;
    }

    _pitch(frame) {
        const minLag = Math.floor(this.sampleRate / 500);
        const maxLag = Math.floor(this.sampleRate / 70);
        const N = frame.length;
        let melhorLag = -1, melhorCorr = 0;

        for (let lag = minLag; lag <= maxLag && lag < N; lag++) {
            let corr = 0, eA = 0, eB = 0;
            for (let i = 0; i < N - lag; i++) {
                corr += frame[i] * frame[i + lag];
                eA += frame[i] * frame[i];
                eB += frame[i + lag] * frame[i + lag];
            }
            const denom = Math.sqrt(eA * eB) || 1;
            const c = corr / denom;
            if (c > melhorCorr) { melhorCorr = c; melhorLag = lag; }
        }
        return (melhorLag > 0 && melhorCorr > 0.3) ? this.sampleRate / melhorLag : 0;
    }

    _mfcc(frame) {
        // Pré-ênfase
        const pre = new Float32Array(frame.length);
        pre[0] = frame[0];
        for (let i = 1; i < frame.length; i++) pre[i] = frame[i] - 0.97 * frame[i - 1];

        // Janelamento
        const jan = new Float32Array(frame.length);
        for (let i = 0; i < frame.length; i++) jan[i] = pre[i] * this._hamming[i];

        // FFT
        const re = new Float32Array(this.fftSize);
        const im = new Float32Array(this.fftSize);
        re.set(jan);
        this._fft(re, im);

        // Potência
        const N = this.fftSize / 2 + 1;
        const pot = new Float32Array(N);
        for (let k = 0; k < N; k++) {
            pot[k] = (re[k] * re[k] + im[k] * im[k]) / this.fftSize;
        }

        // Filtros Mel
        const melE = new Float32Array(this.melFiltros);
        for (let m = 0; m < this.melFiltros; m++) {
            let s = 0;
            const f = this._filtrosMel[m];
            for (let k = 0; k < N; k++) s += pot[k] * f[k];
            melE[m] = Math.max(s, 1e-10);
        }

        // Log + DCT (C1..C12)
        const logMel = new Float32Array(this.melFiltros);
        for (let m = 0; m < this.melFiltros; m++) logMel[m] = Math.log(melE[m]);

        const mfcc = new Float32Array(this.mfccCoefs);
        for (let k = 1; k <= this.mfccCoefs; k++) {
            let s = 0;
            for (let n = 0; n < this.melFiltros; n++) {
                s += logMel[n] * Math.cos(Math.PI * k * (2 * n + 1) / (2 * this.melFiltros));
            }
            mfcc[k - 1] = s;
        }
        return mfcc;
    }

    _centroideEspectral(pot) {
        let num = 0, den = 0;
        for (let k = 0; k < pot.length; k++) {
            const f = k * this.sampleRate / this.fftSize;
            num += f * pot[k];
            den += pot[k];
        }
        return den > 0 ? num / den : 0;
    }

    // ============================================================
    // CAPTURA PROCESSANDO — frame a frame, memória constante
    // ============================================================
    async _capturarProcessando(duracaoMs) {
        return new Promise((resolve) => {
            const inicio = performance.now();
            const mfccs = [], pitches = [], energias = [], zcrs = [], centroides = [];
            let buffer = new Float32Array(this.frameSize);
            let pos = 0;
            const bloco = new Float32Array(2048);

            const loop = () => {
                if (performance.now() - inicio > duracaoMs) {
                    this.rodando = false;
                    resolve({ mfccs, pitches, energias, zcrs, centroides });
                    return;
                }

                this.analyser.getFloatTimeDomainData(bloco);

                for (let i = 0; i < bloco.length; i++) {
                    buffer[pos++] = bloco[i];

                    if (pos >= this.frameSize) {
                        const energia = this._energia(buffer);

                        // Pula frames silenciosos (eficiência)
                        if (energia >= this.energiaMinima) {
                            const zcr = this._zcr(buffer);
                            if (zcr <= this.zcrMaximo) {
                                const mfcc = this._mfcc(buffer);
                                const pitch = this._pitch(buffer);

                                mfccs.push(mfcc);
                                pitches.push(pitch);
                                energias.push(energia);
                                zcrs.push(zcr);

                                // Centroide (reusa a FFT do MFCC? melhor calcular aqui)
                                // Para eficiência, aproxima via MFCC médio
                                let mfccMedia = 0;
                                for (let k = 0; k < mfcc.length; k++) mfccMedia += mfcc[k];
                                centroides.push(mfccMedia / mfcc.length);
                            }
                        }

                        // Hop
                        buffer.copyWithin(0, this.hopSize);
                        pos = this.frameSize - this.hopSize;
                    }
                }

                requestAnimationFrame(loop);
            };

            this.rodando = true;
            loop();
        });
    }

    // ============================================================
    // EMBEDDING — 32 dimensões
    // ============================================================
    _extrairEmbedding({ mfccs, pitches, energias, zcrs, centroides }) {
        if (mfccs.length < 5) return null;

        const C = this.mfccCoefs;

        // Média dos MFCC
        const media = new Float32Array(C);
        for (const m of mfccs) for (let i = 0; i < C; i++) media[i] += m[i];
        for (let i = 0; i < C; i++) media[i] /= mfccs.length;

        // Desvio padrão dos MFCC
        const std = new Float32Array(C);
        for (const m of mfccs) for (let i = 0; i < C; i++) std[i] += Math.pow(m[i] - media[i], 2);
        for (let i = 0; i < C; i++) std[i] = Math.sqrt(std[i] / mfccs.length);

        // Pitch
        const pitchesValidos = pitches.filter(p => p > 0);
        const pitchMed = pitchesValidos.length
            ? pitchesValidos.reduce((a, b) => a + b, 0) / pitchesValidos.length
            : 0;
        let pitchStd = 0;
        if (pitchesValidos.length) {
            for (const p of pitchesValidos) pitchStd += Math.pow(p - pitchMed, 2);
            pitchStd = Math.sqrt(pitchStd / pitchesValidos.length);
        }
        const pitchMin = pitchesValidos.length ? Math.min(...pitchesValidos) : 0;
        const pitchMax = pitchesValidos.length ? Math.max(...pitchesValidos) : 0;

        // Energia
        const energiaMed = energias.reduce((a, b) => a + b, 0) / energias.length;

        // ZCR
        const zcrMed = zcrs.reduce((a, b) => a + b, 0) / zcrs.length;

        // Centroide
        const centroMed = centroides.reduce((a, b) => a + b, 0) / centroides.length;

        // Concatena: 12 + 12 + 4 + 1 + 1 + 1 = 31 dims
        const emb = new Float32Array(31);
        emb.set(media, 0);
        emb.set(std, 12);
        emb[24] = pitchMed;
        emb[25] = pitchStd;
        emb[26] = pitchMax - pitchMin;   // range
        emb[27] = energiaMed;
        emb[28] = zcrMed;
        emb[29] = centroMed;
        emb[30] = pitchesValidos.length / mfccs.length; // proporção de frames com pitch válido

        return this._normalizar(emb);
    }

    _normalizar(v) {
        let n = 0;
        for (let i = 0; i < v.length; i++) n += v[i] * v[i];
        n = Math.sqrt(n) || 1;
        const out = new Float32Array(v.length);
        for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
        return out;
    }

    _cosseno(a, b) {
        let d = 0;
        const len = Math.min(a.length, b.length);
        for (let i = 0; i < len; i++) d += a[i] * b[i];
        return d;
    }

    // ============================================================
    // CATEGORIZAÇÃO AUTOMÁTICA — pelo pitch
    // ============================================================
    _categorizarPorPitch(pitchMed) {
        if (pitchMed <= 0) return { categoria: 'desconhecido', confianca: 0 };

        const f = this.faixas;
        const dist = (faixa) => {
            if (pitchMed >= faixa.min && pitchMed <= faixa.max) return 0;
            return Math.min(Math.abs(pitchMed - faixa.min), Math.abs(pitchMed - faixa.max));
        };

        const dCrianca = dist(f.crianca);
        const dMulher  = dist(f.mulher);
        const dHomem   = dist(f.homem);

        let categoria, distMin;
        if (dCrianca <= dMulher && dCrianca <= dHomem) {
            categoria = 'crianca'; distMin = dCrianca;
        } else if (dMulher <= dHomem) {
            categoria = 'mulher'; distMin = dMulher;
        } else {
            categoria = 'homem'; distMin = dHomem;
        }

        // Confiança inversamente proporcional à distância
        const confianca = Math.max(0, Math.min(1, 1 - distMin / 80));
        return { categoria, confianca };
    }

    // ============================================================
    // PERFIS — armazenamento local (até 10)
    // ============================================================
    _listarPerfis() {
        const perfis = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k.startsWith(this.prefixo)) {
                try {
                    const d = JSON.parse(localStorage.getItem(k));
                    perfis.push({
                        nome: d.nome,
                        categoria: d.categoria || 'desconhecido',
                        embedding: new Float32Array(d.embedding),
                        registradoEm: d.registradoEm
                    });
                } catch (e) {}
            }
        }
        return perfis;
    }

    listarNomes() {
        return this._listarPerfis().map(p => p.nome);
    }

    listar() {
        return this._listarPerfis().map(p => ({
            nome: p.nome,
            categoria: p.categoria,
            registradoEm: p.registradoEm
        }));
    }

    apagar(nome) {
        localStorage.removeItem(this.prefixo + nome);
        console.log(`🗑️ Perfil "${nome}" apagado`);
    }

    apagarTudo() {
        const nomes = this.listarNomes();
        for (const n of nomes) localStorage.removeItem(this.prefixo + n);
        console.log(`🗑️ ${nomes.length} perfis apagados`);
    }

    // ============================================================
    // API PÚBLICA
    // ============================================================

    // Registra um perfil (auto-detecta categoria pelo pitch)
    async registrar(nome, duracaoSegundos = 8) {
        if (!this.audioContext) await this.iniciar();

        const perfis = this._listarPerfis();
        if (perfis.length >= this.maxPerfis && !perfis.find(p => p.nome === nome)) {
            console.error(`❌ Limite de ${this.maxPerfis} perfis atingido. Apague algum.`);
            return false;
        }

        console.log(`🎙️ Registrando "${nome}" por ${duracaoSegundos}s...`);
        const dados = await this._capturarProcessando(duracaoSegundos * 1000);
        const embedding = this._extrairEmbedding(dados);

        if (!embedding) {
            console.error('❌ Features insuficientes — fale mais alto ou mais tempo');
            return false;
        }

        // Categoriza automaticamente
        const pitchMed = embedding[24] * 100; // desnormaliza aproximado
        const { categoria, confianca } = this._categorizarPorPitch(this._pitchReal(dados));

        const perfil = {
            nome,
            categoria,
            embedding: Array.from(embedding),
            registradoEm: new Date().toISOString(),
            confiancaCategoria: confianca
        };
        localStorage.setItem(this.prefixo + nome, JSON.stringify(perfil));

        console.log(`✅ "${nome}" registrado (categoria: ${categoria}, confiança: ${confianca.toFixed(2)})`);
        return true;
    }

    _pitchReal(dados) {
        const validos = dados.pitches.filter(p => p > 0);
        return validos.length ? validos.reduce((a, b) => a + b, 0) / validos.length : 0;
    }

    // Identifica: nome específico + categoria
    async identificar(duracaoMs = 3000) {
        if (!this.audioContext) await this.iniciar();

        const dados = await this._capturarProcessando(duracaoMs);
        const embedding = this._extrairEmbedding(dados);

        if (!embedding) {
            return { nome: null, categoria: 'desconhecido', similaridade: 0, confianca: 0 };
        }

        const pitchMed = this._pitchReal(dados);
        return this._decidir(embedding, pitchMed);
    }

    // Decisão a partir de embedding já pronto (útil para integração)
    identificarDeEmbedding(embedding, pitchMed = 0) {
        return this._decidir(embedding, pitchMed);
    }

    _decidir(embedding, pitchMed) {
        const perfis = this._listarPerfis();
        let melhorNome = null;
        let melhorSim = 0;
        let melhorCategoria = null;

        // 1. Compara com perfis nomeados
        for (const p of perfis) {
            const sim = this._cosseno(embedding, p.embedding);
            if (sim > melhorSim) {
                melhorSim = sim;
                melhorNome = p.nome;
                melhorCategoria = p.categoria;
            }
        }

        // 2. Se bate forte com um nomeado → retorna
        if (melhorSim >= this.limiarSimilaridade) {
            return {
                nome: melhorNome,
                categoria: melhorCategoria || 'desconhecido',
                similaridade: melhorSim,
                confianca: melhorSim
            };
        }

        // 3. Senão, categoriza pelo pitch
        const cat = this._categorizarPorPitch(pitchMed);
        return {
            nome: null,
            categoria: cat.categoria,
            similaridade: melhorSim,
            confianca: cat.confianca,
            desconhecido: melhorSim < 0.6
        };
    }
}

// Expõe globalmente
window.VozIdentidade = VozIdentidade;
