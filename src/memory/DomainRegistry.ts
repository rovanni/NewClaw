/**
 * DomainRegistry — Hub de domínios cognitivos para o grafo de memória
 *
 * Arquitetura: USER → DOMAIN_HUB → MEMORY_NODE (ao invés de USER → tudo flat)
 *
 * 10 domínios pré-definidos + criação emergente controlada (futuro).
 * Classificação por keyword scoring com threshold de confiança.
 */

import { createLogger } from '../shared/AppLogger';
import type { MemoryManager } from './MemoryManager';

const log = createLogger('DomainRegistry');

export interface DomainDefinition {
    id: string;
    name: string;
    description: string;
    keywords: string[];
}

export interface DomainClassification {
    domainId: string;
    confidence: number;
}

export const DOMAIN_DEFINITIONS: DomainDefinition[] = [
    {
        id: 'domain_identidade',
        name: 'IDENTIDADE',
        description: 'Nome, perfil, dados pessoais, profissão, quem é o usuário',
        keywords: ['nome', 'identidade', 'perfil', 'usuário', 'quem sou', 'pessoa', 'profissão', 'cargo', 'trabalho', 'empresa', 'eu sou', 'meu nome', 'chamo', 'sou o', 'sou a']
    },
    {
        id: 'domain_docencia',
        name: 'DOCÊNCIA',
        description: 'Ensino, aulas, slides, materiais educacionais, alunos',
        keywords: ['aula', 'slide', 'ensino', 'docência', 'professor', 'aluno', 'matéria', 'disciplina', 'educação', 'turma', 'curso', 'faculdade', 'universidade', 'escola', 'lecture', 'apresentação']
    },
    {
        id: 'domain_projetos',
        name: 'PROJETOS',
        description: 'Projetos de software, sistemas, desenvolvimento, código',
        keywords: ['projeto', 'sistema', 'aplicação', 'app', 'desenvolvimento', 'código', 'software', 'api', 'backend', 'frontend', 'bot', 'newclaw', 'github', 'deploy', 'typescript', 'python', 'node', 'repositório']
    },
    {
        id: 'domain_cripto',
        name: 'CRIPTO',
        description: 'Criptomoedas, exchange, trading, Bitcoin, portfólio',
        keywords: ['bitcoin', 'btc', 'ethereum', 'eth', 'cripto', 'criptomoeda', 'exchange', 'trading', 'binance', 'portfólio', 'altcoin', 'defi', 'blockchain', 'saldo', 'mercado cripto', 'token', 'carteira']
    },
    {
        id: 'domain_clima',
        name: 'CLIMA',
        description: 'Previsão do tempo, temperatura, chuva, clima',
        keywords: ['clima', 'tempo', 'temperatura', 'chuva', 'sol', 'vento', 'previsão', 'umidade', 'frio', 'calor', 'celsius', 'meteorologia', 'precipitação']
    },
    {
        id: 'domain_infra',
        name: 'INFRA',
        description: 'Infraestrutura, servidores, VPS, SSH, Linux, banco de dados',
        keywords: ['servidor', 'vps', 'ssh', 'linux', 'ubuntu', 'docker', 'nginx', 'banco de dados', 'database', 'infra', 'infraestrutura', 'cloud', 'gpu', 'ram', 'cpu', 'disco', 'memória ram', 'contêiner', 'kubernetes']
    },
    {
        id: 'domain_agenda',
        name: 'AGENDA',
        description: 'Compromissos, tarefas, lembretes, datas, eventos',
        keywords: ['agenda', 'compromisso', 'tarefa', 'lembrete', 'reunião', 'evento', 'prazo', 'deadline', 'horário', 'calendário', 'amanhã', 'semana', 'data', 'marcar', 'agendar']
    },
    {
        id: 'domain_skills',
        name: 'SKILLS',
        description: 'Habilidades do assistente, ferramentas, capacidades do sistema NewClaw',
        keywords: ['skill', 'habilidade', 'ferramenta', 'capacidade', 'função', 'pdf', 'áudio', 'imagem', 'conversão', 'geração', 'assistente', 'newclaw', 'recurso', 'funcionalidade']
    },
    {
        id: 'domain_preferencias',
        name: 'PREFERÊNCIAS',
        description: 'Preferências pessoais do usuário, configurações, gostos, estilo',
        keywords: ['prefere', 'prefiro', 'gosto', 'favorito', 'configuração', 'preferência', 'estilo', 'idioma', 'linguagem', 'formato', 'padrão', 'amo', 'adoro', 'odeio', 'detesto']
    },
    {
        id: 'domain_social',
        name: 'SOCIAL',
        description: 'Família, amigos, relações pessoais, contatos',
        keywords: ['família', 'amigo', 'colega', 'contato', 'pessoa', 'social', 'filho', 'filha', 'esposa', 'marido', 'pai', 'mãe', 'irmão', 'irmã', 'parente', 'namorado', 'namorada']
    }
];

/**
 * Classifica um texto no domínio mais adequado usando keyword scoring.
 * Retorna null se nenhum domínio atinge o threshold mínimo.
 *
 * Score = keyword_hits / sqrt(total_keywords)
 * Confidence = min(score * 2, 1.0)
 * Threshold mínimo: confidence >= 0.15 (pelo menos 1 keyword em domínio pequeno)
 */
export function classifyDomain(text: string): DomainClassification | null {
    if (!text || text.trim().length === 0) return null;

    const normalized = text.toLowerCase();
    let bestDomain: string | null = null;
    let bestScore = 0;

    for (const domain of DOMAIN_DEFINITIONS) {
        let hits = 0;
        for (const keyword of domain.keywords) {
            if (normalized.includes(keyword)) hits++;
        }
        if (hits === 0) continue;
        const score = hits / Math.sqrt(domain.keywords.length);
        if (score > bestScore) {
            bestScore = score;
            bestDomain = domain.id;
        }
    }

    if (!bestDomain || bestScore < 0.08) return null;

    const confidence = Math.min(bestScore * 2.5, 1.0);
    if (confidence < 0.15) return null;

    return { domainId: bestDomain, confidence };
}

export function getDomainById(id: string): DomainDefinition | undefined {
    return DOMAIN_DEFINITIONS.find(d => d.id === id);
}

/**
 * Cria os 10 nós de domínio hub e os conecta ao user_identity.
 * Idempotente: verifica se já existem antes de criar.
 *
 * Deve ser chamado no startup, após o MemoryManager ser inicializado.
 */
export function bootstrapDomains(memoryManager: MemoryManager): void {
    const already = memoryManager.getNode('domain_identidade');
    if (already) {
        log.info('bootstrapDomains', 'Domain hubs already exist, skipping bootstrap');
        return;
    }

    log.info('bootstrapDomains', `Creating ${DOMAIN_DEFINITIONS.length} domain hub nodes...`);

    for (const domain of DOMAIN_DEFINITIONS) {
        try {
            memoryManager.addNode({
                id: domain.id,
                type: 'domain',
                name: domain.name,
                content: domain.description,
                confidence: 1.0,
                weight: 1.0
            }, 'system');

            try {
                memoryManager.addEdge('user_identity', domain.id, 'has_domain', 1.0, 1.0);
            } catch {
                // user_identity might not exist yet in first run — will be retried on next boot
            }
        } catch (e) {
            log.warn('bootstrapDomains', `Failed to create domain hub ${domain.id}: ${String(e)}`);
        }
    }

    log.info('bootstrapDomains', 'Domain hub bootstrap complete');
}
