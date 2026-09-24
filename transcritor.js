// ============================================================
// transcritor.js — Transcrição via Gemini
// projetovozia · Arion
// ============================================================
// O VAD detecta fala e silêncio. Este módulo grava o áudio entre
// os dois eventos e envia pro Gemini transcrever.
// ============================================================

class Transcritor {
    constructor(opcoes = {}) {
        // Configurações
        this.supabaseProject = opcoes.supabaseProject || 'kqccjteefsjwopmwkjay';
        this.transcribeURL = `https://${this.supabaseProject}.supabase.co/functions/v1/arion-chat/transcrever`;
        this.tempoMinimoFala = opcoes.tempoMinimoFala || 300;  // ms mínimos de fala
        this.tempoMaximoGravacao = opcoes.tempoMaximoGravacao || 15000; // 15s máximo

        // Estado
        this.mediaRecorder = null;
        this.chunks = [];
        this.gravando = false;
        this.stream = null;
        this.callbackTexto = null;
        this.tempoInicioFala = 0;
        this.timeoutMaximo = null;

        // Debug
        this.debug = opcoes.debug || false;
    }

    // ============================================================
    // INICIAR — pede acesso ao microfone e prepara o MediaRecorder
    // ============================================================
    async iniciar(callbackTexto) {
        this.callbackTexto = callbackTexto;

        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });

            // Escolhe o melhor formato disponível
            const mimeType = this._escolherMimeType();

            this.mediaRecorder = new MediaRecorder(this.stream, { mimeType });
            this.mimeType = mimeType;

            this.mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) this.chunks.push(e.data);
            };

            this.mediaRecorder.onstop = () => {
                this._enviarAudio();
            };

            if (this.debug) console.log('🎙️ Transcritor pronto. Formato:', mimeType);
            return true;
        } catch (e) {
            console.error('❌ Transcritor erro:', e);
            return false;
        }
    }

    _escolherMimeType() {
        const opcoes = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/ogg;codecs=opus',
            'audio/mp4'
        ];
        for (const tipo of opcoes) {
            if (MediaRecorder.isTypeSupported(tipo)) return tipo;
        }
        return '';
    }

    // ============================================================
    // COMEÇAR GRAVAÇÃO — chamado quando o VAD detecta fala
    // ============================================================
    comecarGravacao() {
        if (this.gravando) return;
        if (!this.mediaRecorder) return;

        // Se o MediaRecorder estiver em estado inválido, tenta recuperar
        if (this.mediaRecorder.state !== 'inactive') {
            try { this.mediaRecorder.stop(); } catch(e) {}
        }

        this.chunks = [];
        this.tempoInicioFala = performance.now();
        this.gravando = true;

        try {
            this.mediaRecorder.start();
            if (this.debug) console.log('🔴 Gravando...');

            // Timeout de segurança: para se gravar demais
            this.timeoutMaximo = setTimeout(() => {
                if (this.gravando) {
                    if (this.debug) console.log('⏱️ Tempo máximo de gravação atingido');
                    this.pararGravacao();
                }
            }, this.tempoMaximoGravacao);

        } catch (e) {
            console.error('❌ Erro ao iniciar gravação:', e);
            this.gravando = false;
        }
    }

    // ============================================================
    // PARAR GRAVAÇÃO — chamado quando o VAD detecta silêncio
    // ============================================================
    pararGravacao() {
        if (!this.gravando) return;

        const duracao = performance.now() - this.tempoInicioFala;
        this.gravando = false;

        if (this.timeoutMaximo) {
            clearTimeout(this.timeoutMaximo);
            this.timeoutMaximo = null;
        }

        // Se foi muito curto, descarta (provavelmente ruído)
        if (duracao < this.tempoMinimoFala) {
            if (this.debug) console.log(`⏭️ Fala muito curta (${Math.round(duracao)}ms), descartando`);
            this.chunks = [];
            try { this.mediaRecorder.stop(); } catch(e) {}
            return;
        }

        if (this.debug) console.log(`⏹️ Parando gravação (${Math.round(duracao)}ms)`);

        try {
            this.mediaRecorder.stop();
        } catch (e) {
            console.error('❌ Erro ao parar gravação:', e);
        }
    }

    // ============================================================
    // ENVIAR ÁUDIO — manda pro Gemini transcrever
    // ============================================================
    async _enviarAudio() {
        if (this.chunks.length === 0) return;

        const blob = new Blob(this.chunks, { type: this.mimeType });
        this.chunks = [];

        // Se o áudio for muito pequeno, ignora
        if (blob.size < 1000) {
            if (this.debug) console.log('⏭️ Áudio muito pequeno, ignorando');
            return;
        }

        if (this.debug) console.log(`📤 Enviando ${Math.round(blob.size / 1024)}KB para transcrição...`);

        try {
            // Converte Blob → Base64
            const base64 = await this._blobParaBase64(blob);

            const resp = await fetch(this.transcribeURL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    audioBase64: base64,
                    mimeType: this.mimeType.split(';')[0] // remove codecs
                })
            });

            if (!resp.ok) {
                const err = await resp.text();
                console.error('❌ Transcrição falhou:', err);
                return;
            }

            const data = await resp.json();
            const texto = data?.texto || '';

            if (texto && this.callbackTexto) {
                if (this.debug) console.log('📝 Transcrito:', texto);
                this.callbackTexto(texto);
            } else {
                if (this.debug) console.log('⏭️ Transcrição vazia');
            }

        } catch (e) {
            console.error('❌ Erro ao enviar áudio:', e);
        }
    }

    _blobParaBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64 = reader.result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    // ============================================================
    // PARAR — libera o microfone
    // ============================================================
    parar() {
        this.gravando = false;
        if (this.timeoutMaximo) {
            clearTimeout(this.timeoutMaximo);
            this.timeoutMaximo = null;
        }
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            try { this.mediaRecorder.stop(); } catch(e) {}
        }
        if (this.stream) {
            this.stream.getTracks().forEach(t => t.stop());
            this.stream = null;
        }
        console.log('🎙️ Transcritor parado');
    }
}

// Expõe globalmente
window.Transcritor = Transcritor;
