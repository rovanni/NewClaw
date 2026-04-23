# Sites de Criptomoedas

Estrutura de páginas/painéis por moeda.

## Como usar
- Cada moeda tem sua pasta: `river/`, `btc/`, `eth/`, etc.
- Use o template em `template/` para criar novas páginas
- Checklist de venda, análise,跟踪 — tudo aqui

## Estrutura
```
sites/
├── README.md
├── template/          ← Template reutilizável
│   └── checklist-venda.html
├── river/             ← RIVER
│   └── checklist-venda.html
└── [nova-moeda]/      ← Criar pasta quando comprar
    └── checklist-venda.html
```