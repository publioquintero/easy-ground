# Easy Ground

Asistente de ruta para conductores de FedEx Ground: importa las paradas desde GroundCloud, ordena la ruta para entregar siempre por el lado derecho y avisa de caminos privados. Plan completo en [docs/PLAN.md](docs/PLAN.md).

## Estructura

| Carpeta | Qué es |
|---|---|
| `packages/core` | TypeScript puro: modelo de datos, parser, utilidades geográficas (reusable en React Native) |
| `apps/web` | Prototipo PWA: React + Vite + Redux Toolkit |
| `backend` | API en Python + FastAPI |
| `docker-compose.yml` | Infraestructura (Postgres, Redis, RustFS) y, con `--profile app`, la API y la web |
| `docs/samples/` | Capturas reales de GroundCloud (**fuera de git**: contienen datos de clientes) |

## Todo en Docker

Levanta Postgres, Redis, la API (FastAPI) y la web (nginx) en contenedores:

```bash
docker compose --profile app up -d --build
```

La app queda en http://localhost:8080 y nginx manda `/api` al contenedor de la API. La llave de Google se lee de `backend/.env` al arrancar; nunca se mete en la imagen.

Para apagar todo:

```bash
docker compose --profile app down
```

El almacenamiento de archivos es **RustFS** (compatible con S3; reemplaza a MinIO, ver D7 en el plan). Consola web: http://localhost:9001/rustfs/console/ (usuario `easyground`, contraseña `easyground-dev-secret`, solo para desarrollo). La API crea el bucket `easy-ground` al arrancar.

## Montar en un servidor (producción)

Lo que cambia respecto a local está en [deploy/](deploy/): Caddy al frente con **HTTPS automático** (Let's Encrypt) y **usuario y contraseña**. Postgres, Redis y el almacenamiento no exponen puertos (Docker se salta ufw) y usan contraseñas reales.

Una sola vez:

1. En el servidor: Docker instalado, puertos 80 y 443 abiertos y al menos 2 GB de RAM (o swap): la web se compila con Node ahí mismo.
2. En el DNS de tu dominio: un registro **A** del subdominio (por ejemplo `ruta.tudominio.com`) a la IP del servidor.
3. En el servidor, dentro de `~/easy-ground`:
   - `backend/.env` con `GOOGLE_MAPS_API_KEY=...`
   - `deploy/.env`, copiado de [deploy/.env.example](deploy/.env.example). El hash de la contraseña se genera con `docker run --rm caddy:2.8.4-alpine caddy hash-password --plaintext 'tu-clave'`, y cada `$` del hash se escribe `$$`.

Cada vez que haya cambios, desde esta Mac (`mi-vps` es el host de tu `~/.ssh/config`):

```bash
deploy/deploy.sh mi-vps
```

El script copia el código con rsync (nunca los `.env`, `docs/` ni las muestras), reconstruye y reinicia. En la llave de Google conviene restringirla a las APIs que usa la app (Geocoding, Geocoding v4 y Routes) y a la IP del servidor.

## Arrancar en local (modo desarrollo)

Solo la infraestructura (Postgres, Redis, almacenamiento):

```bash
docker compose up -d
```

```bash
npm install
```

```bash
cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt && { [ -f .env ] || cp .env.example .env; }
```

```bash
backend/.venv/bin/uvicorn app.main:app --app-dir backend --reload --port 8000
```

```bash
npm run dev
```

La web queda en http://localhost:5173 (también accesible desde el iPhone en la misma red) y hace proxy de `/api` al backend.

## Pruebas

```bash
npm test && npm run typecheck
```

```bash
cd backend && .venv/bin/python -m pytest && .venv/bin/ruff check app tests
```
