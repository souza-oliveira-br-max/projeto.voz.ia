// ============================================================
// localizador.js — Detecção de Rede / Localização
// projetovozia · Arion
// ============================================================
// Detecta em qual rede o Arion está rodando comparando o IP
// público com perfis salvos (casa, trabalho, outro).
//
// Uso:
//   const loc = new Localizador({ debug: true });
//   await loc.iniciar();
//   const onde = await loc.identificar();  // { local: 'casa', ... }
//   loc.rotular('casa');   // rotula o IP atual como "casa"
// ============================================================

class Localizador {
    constructor(opcoes = {}) {
        this.prefixo = 'arion:local:';
        this.cachePrefixo = 'arion:local:cache:';
        this.tempoCache = opcoes.tempoCache || 5 * 60 * 1000; // 5 min

        // APIs públicas (fallback em cascata)
        this.apis = [
            {
                nome: 'ipapi.co',
                url: 'https://ipapi.co/json/',
                parse: (d) => ({
                    ip: d.ip,
                    cidade: d.city,
                    regiao: d.region,
                    pais: d.country_code,
                    org: d.org,
                    timezone: d.timezone
                })
            },
            {
                nome: 'ipwho.is',
                url: 'https://ipwho.is/',
                parse: (d) => ({
                    ip: d.ip,
                    cidade: d.city,
                    regiao: d.region,
                    pais: d.country_code,
                    org: d.connection?.isp || d.connection?.org,
                    timezone: d.timezone?.id
                })
            },
            {
                nome: 'ipify',
                url: 'https://api.ipify.org?format=json',
                parse: (d) => ({
                    ip: d.ip,
                    cidade: null,
                    regiao: null,
                    pais: null,
                    org: null,
                    timezone: null
                })
            }
        ];

        // Estado
        this.atual = null;
        this.ultimaConsulta = 0;
        this.debug = opcoes.debug || false;
        this.callbackMudanca = null;
        this.rodando = false;
        this.intervaloMonitor = null;
    }

    // ============================================================
    // INICIALIZAÇÃO
    // ============================================================
    async iniciar() {
        const info = await this._buscarInfoIP();
        if (!info) {
            console.warn('⚠️ Localizador: não consegui obter IP');
            return false;
        }

        this.atual = info;
        this.ultimaConsulta = Date.now();

        if (this.debug) {
            console.log('🌐 Localizador:', info);
        }

        return true;
    }

    // ============================================================
    // BUSCA DE IP (com cache + fallback entre APIs)
    // ============================================================
    async _buscarInfoIP() {
        // Verifica cache
        const cache = this._lerCache();
        if (cache && Date.now() - cache.timestamp < this.tempoCache) {
            if (this.debug) console.log('📦 IP do cache');
            return cache.dados;
        }

        // Tenta cada API em ordem
        for (const api of this.apis) {
            try {
                const ctrl = new AbortController();
                const timeout = setTimeout(() => ctrl.abort(), 5000);

                const resp = await fetch(api.url, { signal: ctrl.signal });
                clearTimeout(timeout);

                if (!resp.ok) continue;
                const data = await resp.json();
                const info = api.parse(data);

                if (info && info.ip) {
                    info.api = api.nome;
                    info.timestamp = Date.now();
                    this._salvarCache(info);

                    if (this.debug) console.log(`✅ IP via ${api.nome}:`, info.ip);
                    return info;
                }
            } catch (e) {
                if (this.debug) console.warn(`⚠️ ${api.nome} falhou:`, e.message);
                continue;
            }
        }

        return null;
    }

    _lerCache() {
        try {
            const raw = localStorage.getItem(this.cachePrefixo + 'ip');
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (e) {
            return null;
        }
    }

    _salvarCache(dados) {
        try {
            localStorage.setItem(this.cachePrefixo + 'ip', JSON.stringify({
                dados,
                timestamp: Date.now()
            }));
        } catch (e) {}
    }

    limparCache() {
        localStorage.removeItem(this.cachePrefixo + 'ip');
        if (this.debug) console.log('🗑️ Cache de IP limpo');
    }

    // ============================================================
    // FINGERPRINT — assinatura da rede
    // ============================================================
    _fingerprintExato(info) {
        return info.ip || '';
    }

    _fingerprintSubnet(info) {
        if (!info.ip) return '';
        // IPv4: primeiros 3 octetos (ex: 191.10.20.x → 191.10.20)
        const partes = info.ip.split('.');
        if (partes.length === 4) {
            return partes.slice(0, 3).join('.');
        }
        return info.ip;
    }

    // ============================================================
    // PERFIS — locais rotulados pelo usuário
    // ============================================================
    _listarPerfis() {
        const perfis = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k.startsWith(this.prefixo) && !k.startsWith(this.cachePrefixo)) {
                try {
                    const p = JSON.parse(localStorage.getItem(k));
                    perfis.push(p);
                } catch (e) {}
            }
        }
        return perfis;
    }

    listar() {
        return this._listarPerfis().map(p => ({
            nome: p.nome,
            ip: p.ip,
            subnet: p.subnet,
            cidade: p.cidade,
            org: p.org,
            rotuladoEm: p.rotuladoEm,
            vezesVisto: p.vezesVisto || 1
        }));
    }

    // ============================================================
    // IDENTIFICAÇÃO — compara IP atual com perfis salvos
    // ============================================================
    async identificar() {
        if (!this.atual || Date.now() - this.ultimaConsulta > this.tempoCache) {
            await this.iniciar();
        }

        if (!this.atual) {
            return {
                local: 'desconhecido',
                motivo: 'sem_ip',
                ip: null,
                confianca: 0
            };
        }

        const ipExato = this._fingerprintExato(this.atual);
        const subnet = this._fingerprintSubnet(this.atual);
        const perfis = this._listarPerfis();

        // 1. Match exato de IP
        for (const p of perfis) {
            if (p.ip === ipExato) {
                this._marcarVisto(p.nome);
                return {
                    local: p.nome,
                    motivo: 'ip_exato',
                    ip: this.atual.ip,
                    cidade: this.atual.cidade,
                    org: this.atual.org,
                    confianca: 1.0
                };
            }
        }

        // 2. Match por subnet (IP dinâmico na mesma rede)
        for (const p of perfis) {
            if (p.subnet && p.subnet === subnet) {
                this._marcarVisto(p.nome);
                return {
                    local: p.nome,
                    motivo: 'subnet',
                    ip: this.atual.ip,
                    cidade: this.atual.cidade,
                    org: this.atual.org,
                    confianca: 0.85
                };
            }
        }

        // 3. Match por org + cidade (fallback fraco)
        for (const p of perfis) {
            if (p.cidade && p.org && p.cidade === this.atual.cidade && p.org === this.atual.org) {
                return {
                    local: p.nome,
                    motivo: 'cidade_org',
                    ip: this.atual.ip,
                    cidade: this.atual.cidade,
                    org: this.atual.org,
                    confianca: 0.6
                };
            }
        }

        // 4. Nenhum match
        return {
            local: 'desconhecido',
            motivo: 'sem_match',
            ip: this.atual.ip,
            cidade: this.atual.cidade,
            org: this.atual.org,
            confianca: 0
        };
    }

    // ============================================================
    // ROTULAR — salva o IP atual com um nome
    // ============================================================
    rotular(nome) {
        if (!this.atual || !this.atual.ip) {
            console.error('❌ Localizador: sem IP atual. Chame iniciar() primeiro.');
            return false;
        }

        const perfil = {
            nome,
            ip: this.atual.ip,
            subnet: this._fingerprintSubnet(this.atual),
            cidade: this.atual.cidade,
            regiao: this.atual.regiao,
            pais: this.atual.pais,
            org: this.atual.org,
            timezone: this.atual.timezone,
            rotuladoEm: new Date().toISOString(),
            vezesVisto: 1
        };

        localStorage.setItem(this.prefixo + nome, JSON.stringify(perfil));
        console.log(`✅ Local "${nome}" salvo (${this.atual.ip}, ${this.atual.cidade || '?'})`);
        return true;
    }

    apagar(nome) {
        localStorage.removeItem(this.prefixo + nome);
        console.log(`🗑️ Local "${nome}" apagado`);
    }

    apagarTudo() {
        const perfis = this._listarPerfis();
        for (const p of perfis) {
            localStorage.removeItem(this.prefixo + p.nome);
        }
        console.log(`🗑️ ${perfis.length} locais apagados`);
    }

    _marcarVisto(nome) {
        try {
            const perfil = JSON.parse(localStorage.getItem(this.prefixo + nome));
            if (perfil) {
                perfil.vezesVisto = (perfil.vezesVisto || 0) + 1;
                perfil.ultimaVez = new Date().toISOString();
                localStorage.setItem(this.prefixo + nome, JSON.stringify(perfil));
            }
        } catch (e) {}
    }

    // ============================================================
    // MONITOR — vigia mudanças de rede em intervalo
    // ============================================================
    monitorar(callback, intervaloMs = 60000) {
        this.callbackMudanca = callback;
        this.rodando = true;

        let ultimoLocal = null;

        const checar = async () => {
            if (!this.rodando) return;

            this.limparCache(); // força nova consulta
            await this.iniciar();
            const onde = await this.identificar();

            if (onde.local !== ultimoLocal && ultimoLocal !== null) {
                // Mudou de local!
                if (this.debug) console.log(`📍 Mudou: ${ultimoLocal} → ${onde.local}`);
                if (this.callbackMudanca) this.callbackMudanca(onde, ultimoLocal);
            } else if (ultimoLocal === null && this.debug) {
                console.log(`📍 Local inicial: ${onde.local}`);
            }

            ultimoLocal = onde.local;
        };

        // Primeira checagem
        checar();

        // Agenda
        this.intervaloMonitor = setInterval(checar, intervaloMs);
        if (this.debug) console.log(`👁️ Monitorando rede a cada ${intervaloMs / 1000}s`);
    }

    pararMonitoramento() {
        this.rodando = false;
        if (this.intervaloMonitor) {
            clearInterval(this.intervaloMonitor);
            this.intervaloMonitor = null;
        }
        console.log('⏹️ Monitoramento de rede parado');
    }

    // ============================================================
    // UTILITÁRIO — resumo legível
    // ============================================================
    resumo() {
        if (!this.atual) return 'Sem informação de rede';
        const partes = [];
        if (this.atual.cidade) partes.push(this.atual.cidade);
        if (this.atual.regiao) partes.push(this.atual.regiao);
        if (this.atual.org) partes.push(this.atual.org);
        return partes.join(' · ') || this.atual.ip;
    }
}

// Expõe globalmente
window.Localizador = Localizador;
