# Política de Seguridad

> **Language / Idioma:**
> 🇺🇸 [English](SECURITY.md) | 🇧🇷 [Português](SECURITY.pt-br.md) | 🇪🇸 **Español**

## Cómo reportar una vulnerabilidad

**No abras un issue público para problemas de seguridad.** Un reporte público avisa a todos los
que ejecutan NewClaw sobre la falla antes de que exista una corrección — incluidos quienes la
explotarían.

Repórtala en privado mediante GitHub Security Advisories:

**https://github.com/rovanni/NewClaw/security/advisories/new**

Esto crea una conversación privada, visible solo para ti y para quienes mantienen el proyecto.

Si no puedes usar ese formulario, abre un issue diciendo únicamente que tienes un reporte de
seguridad para enviar — sin ningún detalle técnico — y espera el contacto.

### Qué ayuda en el reporte

- Qué logra un atacante (leer archivos, evadir la autenticación, ejecutar comandos…)
- Pasos para reproducirlo, o una prueba de concepto mínima
- Versión afectada (`package.json` → `version`) y sistema operativo
- Tu configuración, **sin los secretos** — quita claves de API, tokens, contraseñas y rutas personales

### Qué esperar

Este es un proyecto mantenido por voluntarios, sin equipo pago de seguridad, así que no hay un
plazo de respuesta garantizado. Lo que sí se promete: los reportes se leen, las vulnerabilidades
confirmadas se corrigen y se publican como advisory, y el crédito va a quien la reportó — salvo
que prefieras lo contrario.

## Versiones con soporte

Las correcciones entran en la rama `main`. No hay soporte a largo plazo para versiones antiguas:
la recomendación es ejecutar siempre la última versión publicada.

| Versión | Con soporte |
|---|---|
| 2.x | ✅ |
| < 2.0 | ❌ |

## Dónde NewClaw maneja datos sensibles

Útil para quien audite el proyecto, y para quien lo ejecuta:

- **`.env`** — guarda claves de API, tokens de los canales y la contraseña del panel. Nunca se
  versiona (está en `.gitignore`); `.env.example` solo trae campos vacíos.
- **Panel web** — escucha en `127.0.0.1` por defecto. Exponerlo en la red
  (`DASHBOARD_HOST=0.0.0.0`) **exige** definir `DASHBOARD_PASSWORD`; sin ella, `/api/*` queda
  abierto a cualquiera que alcance el puerto.
- **Ejecución de comandos** — el agente ejecuta comandos del sistema mediante sus herramientas.
  Los patrones destructivos se bloquean sin excepción, y las acciones peligrosas requieren
  aprobación explícita en modo SAFE. Quien gobierna esto es el modo de capacidad: elevarlo amplía
  lo que se ejecuta sin preguntar.
- **Servidores de modelo local** — cargar un modelo desde el panel ejecuta un binario encontrado
  en la carpeta que *tú* configuraste. Del navegador solo viaja el nombre del archivo, verificado
  contra el listado real de la carpeta; el ejecutable y sus argumentos se resuelven en el servidor.
- **Memoria de conversaciones** — se guarda en una base SQLite local (`data/`), sin cifrado.
  Quien tenga acceso al sistema de archivos de la máquina puede leerla.

## Advisories conocidos

Los advisories publicados están en
[github.com/rovanni/NewClaw/security/advisories](https://github.com/rovanni/NewClaw/security/advisories).

Cada vulnerabilidad corregida tiene una prueba de regresión que falla si la falla regresa — por
ejemplo `S129_DashboardAuth_GHSA_jpx8_29mp_v4hw`, que cubre GHSA-jpx8-29mp-v4hw (tokens de
autenticación firmados con clave HMAC vacía). Verificar una corrección es ejecutar la suite:

```bash
npm run test:regression
```
