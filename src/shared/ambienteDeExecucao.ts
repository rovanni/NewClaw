/**
 * O ambiente em que os comandos do agente rodam DE VERDADE — para quem julga (os juízes do motor único) saber se um comando,
 * um caminho ou uma dica de instalação servem a esta máquina.
 *
 * Origem (Telegram, 15/10/2026): o juiz de risco aprovou um plano com `py -3 -m pip install … 2>$null; py -3 script.py` — sintaxe
 * de PowerShell — num Windows em que o exec_command roda esse comando no cmd.exe (onde `;` não separa comandos e `$null` vira
 * nome de arquivo). O juiz não tinha como saber: ninguém lhe dizia o sistema nem o shell.
 *
 * O texto descreve o COMPORTAMENTO do exec_command (tools/exec_command.ts: shell padrão do child_process; `needsPowerShellWrap`
 * no Windows). Módulo-folha: o motor dos juízes o lê sem depender da ferramenta. O S409 prende os dois — mudou o roteamento do
 * exec_command, o teste falha até este texto ser atualizado.
 */
export function descreverAmbienteDeExecucao(plataforma: NodeJS.Platform = process.platform): string {
    if (plataforma === 'win32') {
        return 'Sistema operacional: Windows. Os comandos do exec_command rodam no cmd.exe — exceto os que contêm um cmdlet do ' +
            'PowerShell (Verbo-Substantivo, ex.: Get-ChildItem) ou um comando típico de Linux (ls, cat, grep, rm…), que vão para o ' +
            'powershell.exe (Windows PowerShell 5.1, que não aceita "&&" nem "||"). No cmd.exe, ";" não separa comandos e ' +
            '"2>$null" não descarta erros. ' +
            'Instaladores de Linux (apt-get, yum) não existem aqui.';
    }
    if (plataforma === 'darwin') return 'Sistema operacional: macOS. Os comandos do exec_command rodam no /bin/sh.';
    return `Sistema operacional: ${plataforma === 'linux' ? 'Linux' : plataforma}. Os comandos do exec_command rodam no /bin/sh.`;
}
