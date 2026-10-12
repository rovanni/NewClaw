@docs/DIRETRIZ_ARQUITETURA_2026-07-13.md
@docs/ARCHITECTURE.md

# Instruções adicionais para o trabalho neste projeto

1. **Rastrear os acontecimentos pelos logs.** Ao investigar um problema, correlacione os registros por data e horário no log de auditoria local `NewClaw\logs\newclaw-audit.log` dentro do perfil do usuário (por exemplo, `%USERPROFILE%\NewClaw\logs\newclaw-audit.log` no Windows). Não inclua caminhos de perfil pessoal nos arquivos do projeto. Trate logs como evidência e verifique sua disponibilidade antes de depender deles.

2. **Corrigir em função do objetivo do usuário.** Investigue a causa do problema e corrija-o considerando como o NewClaw pode cumprir o objetivo solicitado pelo usuário, em vez de apenas mascarar o sintoma observado.

3. **Preservar compatibilidade multiplataforma e multilíngue.** O NewClaw é um projeto Open Source destinado a Windows, Linux e macOS, com suporte a português, inglês e espanhol. Evite soluções específicas de uma máquina, sistema operacional, idioma ou configuração quando não forem parte comprovada dos requisitos. Prefira soluções holísticas que respeitem a arquitetura e os contratos existentes.

4. **Proteger dados sensíveis.** Não inclua dados pessoais, credenciais, caminhos privados ou outros segredos da mantenedora no código, nos testes, na documentação ou nos arquivos publicados do NewClaw. Use exemplos genéricos e mecanismos apropriados de configuração.

5. **Basear mudanças em evidências concretas.** Faça correções sustentadas por evidências verificáveis, como logs, código, reproduções ou documentação pertinente. Distinga fatos observados de hipóteses e não altere comportamento sem justificativa ligada ao problema investigado.

6. **Verificar regressões e o fluxo completo de navegação.** Após cada modificação, verifique as regressões pertinentes e percorra a navegação como uma pessoa usuária iniciante, seguindo o fluxo completo desde o início até o resultado, sem pular etapas. Informe o que foi verificado e quaisquer limitações do ambiente. Não afirme que verificações foram feitas se não foram executadas.

7. **Consultar os alertas de segurança do GitHub.** Ao trabalhar neste projeto, verifique os problemas reportados em [GitHub Security do NewClaw](https://github.com/rovanni/NewClaw/security) e considere os alertas relevantes para a mudança investigada.

8. **Determinar quem decide e com quais informações.** Antes de escolher mecanismo para uma decisão, siga a diretriz **Responsabilidade antes do Mecanismo** (`docs/ARCHITECTURE/RESPONSABILIDADE_ANTES_DO_MECANISMO.md`): determinismo valida aspectos objetivos e estruturais; interpretação semântica cabe ao LLM ou componente semântico apropriado, sem regex ou heurísticas como substitutos. Para qualquer decisão delegada a um LLM, aplique **Informação Completa para Decidir** (`docs/ARCHITECTURE/INFORMACAO_COMPLETA_PARA_DECIDIR.md`): forneça as informações necessárias para a decisão, torne lacunas explícitas e não espere que o modelo infira contexto que não recebeu.

9. **Manter uma única fonte autoritativa de conhecimento (ARCH).** Aplique os critérios de **Quando Extrair Duplicação** (`docs/ARCHITECTURE/QUANDO_EXTRAIR_DUPLICACAO.md`) para decidir quando conhecimento compartilhado precisa de uma representação autoritativa e quando duplicação independente deve permanecer.
10. **Conduzir investigações que cruzam camadas como uma única campanha.** Quando um problema atravessar mais de uma camada arquitetural, investigue-o de ponta a ponta como uma campanha única, com etapas internas e sequenciais:

    1. Mapeie o fluxo completo da entrada até a saída e defina as sprints necessárias para investigar o problema inteiro.
    2. Trate as sprints como etapas da mesma campanha, não como investigações independentes nem checkpoints de aprovação.
    3. Incorpore novas descobertas relacionadas ao problema original à sprint adequada ou a uma nova sprint da mesma campanha; não inicie outra campanha para fragmentar o mesmo problema.
    4. Execute todas as sprints aplicáveis sem pedir confirmação entre elas e apresente uma única conclusão consolidada ao final.
    5. Registre problemas que não pertençam ao problema original como **fora do escopo**, sem desviar a campanha.
    6. Não tome decisões arquiteturais sem evidências. Se uma decisão depender do julgamento do usuário, conclua as análises possíveis, registre evidências, alternativas e riscos, marque-a como **pendente** e apresente-a na conclusão consolidada.

    O objetivo é investigar profundamente o problema inteiro, organizar e executar o trabalho em etapas internas sem fragmentar a campanha nem substituir decisões desconhecidas por hipóteses, e entregar uma única conclusão consolidada.
