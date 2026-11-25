# Easy Ground — Plan de implementación

> Basado en el plano técnico (`docs/Plano Técnico_ ... (GroundCloud).pdf`) y en lo que se confirmó sobre GroundCloud el 2026-11-24.
> Última actualización: 2026-11-24 (Fase 2).

## 1. Objetivo

Una app para iPhone, usada por un conductor contratista de FedEx Ground, que:

1. **Importa las paradas del día desde GroundCloud** en segundos. GroundCloud corre en el mismo iPhone.
2. **Ordena la ruta** y, si el conductor lo activa, **prefiere** que cada entrega quede **del lado derecho**, el de la puerta de carga (preferencia configurable, no regla estricta).
3. **Avisa de caminos privados largos** antes de pasar la entrada.
4. Muestra una **tarjeta de parada** de alto contraste: número de casa gigante, paquetes y estante (SID).

GroundCloud ya tiene mapa, navegación y los botones de entregado e intento. **Nada de eso se replica.** La app aporta el orden de la ruta, las alertas y la tarjeta en cabina.

## 2. Decisiones ya tomadas

| Tema | Decisión | Motivo |
|---|---|---|
| Plataforma (prototipo) | **Web: React + Vite + TypeScript, como PWA** | Valida rápido el parser, el ruteo y la UI desde Safari en el iPhone, sin App Store |
| Plataforma (app real) | **React Native**, si el prototipo convence | Reusa la lógica TypeScript de `packages/core`; geocercas nativas en segundo plano |
| Backend | **Python + FastAPI** | Guarda las llaves de Google, cachea geocodificaciones, corre el motor de ruta y la sincronización |
| Base de datos | **PostgreSQL** (+ PostGIS más adelante) | Paradas, rutas, geocodificaciones confirmadas y notas compartidas |
| Estado en el frontend | **Redux Toolkit** + RTK Query | Estado de la ruta (paradas, revisión, parada actual) y llamadas a la API con caché |
| Almacenamiento de archivos | **RustFS** (API S3, vía `boto3`, direcciones path-style); antes MinIO, ver D7 | Fotos de portones y buzones, PDFs importados; intercambiable por S3 o R2 |
| Caché del backend | **Redis** | Caché rápida de geocodificación y de rutas optimizadas (ahorra llamadas a Google); más adelante, cola de trabajos |
| Dispositivo de captura | **El iPhone del conductor**, donde también está GroundCloud | No hace falta apuntar la cámara al iPad |
| Fuente principal | **Manifest View** de GroundCloud: una tabla con unas 16 paradas por pantalla | Se capturan muchas paradas a la vez |
| Lado derecho | **Configurable**: *Off*, *Prefer* (por defecto) o *Strict*. En *Prefer* es una penalización suave con tope de desvío: solo cambia el orden si el rodeo extra es pequeño | No es estricto en la práctica y forzarlo hace dar vueltas innecesarias (U-turns, rodeos de manzana) |
| Clave de una parada | La columna **`#`** de Manifest View | El SID se repite entre paradas (ejemplo: 6000 en las paradas 6 y 7) |
| SID | Se trata como **estante o zona de carga** (`shelf_id`), no como ID de paquete | Así lo muestra GroundCloud |
| Ciudad y ZIP | El conductor los pone una vez como **área de ruta**, o se usa la ubicación del teléfono | Manifest View no muestra ciudad ni ZIP |
| Optimización | Se hace **en tandas de 10–15 paradas**, encadenadas | Evita los límites de paradas de las APIs de ruteo |
| Navegación paso a paso | **Se delega** a Google Maps o Apple Maps, con destino en el punto de entrada | No vale la pena reconstruir la navegación |
| Datos de clientes | Se quedan **en el teléfono**. Las muestras reales van a `docs/samples/` y esa carpeta va al `.gitignore` | Contienen nombres y direcciones reales (PII) |

## 3. Fuentes de captura

Todas las fuentes producen lo mismo: un arreglo de `StopDraft`. Luego todas pasan por la misma pantalla de revisión.

| Prioridad | Fuente | Técnica | Estado |
|---|---|---|---|
| 1 | PDF impreso desde Manifest View (🖨️ → Guardar en Archivos) | PDFKit: texto directo, sin OCR | **Por confirmar** que el PDF traiga texto real |
| 2 | Capturas de Manifest View (3–4 imágenes) | Vision `VNRecognizeTextRequest` + reconstrucción de columnas por coordenada X | **MVP** |
| 3 | Grabación de pantalla de la tarjeta de parada | Cuadros del video en el navegador (`<video>` + canvas), se descartan repetidos, OCR con Tesseract.js; se empareja con la ruta por dirección | **Funciona en el prototipo** (falta probar con una grabación real) |
| 4 | Foto de la pantalla del iPad con la cámara | El mismo OCR que las capturas; el parser sigue la inclinación y la perspectiva (líneas de Tesseract + columnas que se ajustan fila a fila) | **Funciona en el prototipo** (15/16 paradas en la foto de prueba, con marcas ámbar) |
| 5 | Entrada o corrección manual | Formulario | **MVP** |
| 6 | **Foto de la etiqueta FedEx de un paquete** | Leer el código de barras 2D de la etiqueta y, si no se puede, OCR del bloque "SHIP TO" | **Funciona en el prototipo** (falta probar con etiquetas reales) |

### Captura de etiqueta FedEx (fuente 6)
Sirve para paradas que **no están en el manifiesto** (paquetes reasignados o agregados en ruta), y para ubicar en la ruta un paquete que el conductor tiene en la mano.

1. El conductor toma una foto de la etiqueta del paquete con la cámara del teléfono.
2. **Primer intento, código de barras:** las etiquetas de FedEx Ground traen un código 2D (PDF417 o MaxiCode) con los datos del envío, normalmente incluida la dirección del destinatario, y un código 1D con el número de rastreo. Se lee en el navegador con una librería de códigos de barras (por ejemplo ZXing). **Por confirmar:** qué formato usan las etiquetas reales y si la librería lee MaxiCode.
3. **Respaldo, OCR:** si el código no se lee, OCR del bloque de destinatario ("SHIP TO": nombre, dirección, ciudad, estado y ZIP) con el mismo Tesseract.js.
4. **Coincidencia con la ruta:**
   - Si la dirección (o el número de rastreo) ya corresponde a una parada, se suma el paquete a esa parada y se muestra su número y su SID.
   - Si no, se crea una parada nueva marcada **"Added from label"**, pasa por la misma revisión y edición, y se inserta en la ruta.
5. **Al mapa:** la parada nueva se geocodifica, aparece en el mapa y el motor de ruta la mete en la tanda que corresponde, sin reordenar toda la ruta.

Riesgos: reflejos y etiquetas arrugadas; el formato exacto del código 2D no es público y puede variar. Hacen falta fotos de etiquetas reales (con los datos del cliente tapados o borrados) para diseñar y probar el parser.

### Parser de Manifest View (fuente 2)
- Columnas: `#`, `D/P`, `SID`, `Pkgs`, `Name`, `Address`, `Address 2` y una columna de estado.
- Las filas se arman agrupando los bloques de texto por coordenada Y. La columna se asigna según la posición X de cada encabezado.
- Si el estado dice `Delivered …` o `Attempted …`, la parada se marca como completada y se excluye del ruteo.
- Las filas repetidas entre capturas se fusionan usando `#`.
- **Direcciones cortadas** (`11316 N EAGLE LAKE B…`):
  1. Se recomienda al conductor ocultar las columnas Name y D/P con FILTER y capturar en horizontal.
  2. Si aún sale cortada, se completa con autocompletado del geocoder, limitado al área de ruta.
  3. Toda dirección completada así se marca en **ámbar** en la revisión.

### Datos de prueba
Se usa la captura de Manifest View de 16 paradas como fixture (`Tests/Fixtures/manifest_tablet_01.png`), con su JSON esperado escrito a mano. Las fixtures con datos reales no se suben a ningún repositorio público.

## 4. Arquitectura

```
[Navegador / PWA — apps/web]                      [Backend — backend/ (FastAPI)]
Capture (capturas, PDF)                            /geocode  ─► Google Geocoding (+ caché en Postgres)
  └─► OCR (Tesseract.js) ─► Parser (core)          /routes/optimize ─► clusters + Google Routes
        └─► [StopDraft] ─► Revisión ──────────────►   └─► detección de camino privado
                                 ◄──────────────── ruta ordenada
Modo manejo: tarjeta, voz, Wake Lock, abrir Maps   /stops, /notes (Fase 3: sync)
Estado: Redux Toolkit + RTK Query                  Redis (caché) + PostgreSQL + RustFS (fotos, S3)
```

- **El OCR y el parser corren en el navegador.** Las capturas con nombres de clientes no salen del teléfono; al backend solo llegan las direcciones.
- **La llave de Google vive solo en el backend.** El navegador nunca la ve.

Estructura del repositorio:
- `packages/core`: TypeScript puro. Modelo, parser de Manifest View y utilidades geográficas. Se puede probar con fixtures y luego se reusa en React Native.
- `apps/web`: UI en React, captura, OCR y modo manejo.
- `backend`: FastAPI, cliente de Google, motor de ruta y acceso a Postgres.
- `docker-compose.yml`: Postgres, Redis y RustFS (S3) locales; con `--profile app`, también la API y la web.

## 5. Modelo de datos (v2)

Respecto al plano original: se agregan `stop_number`, `stop_type`, `customer_name`, `address_line2` y los campos de confianza del OCR. `sid_code` y `shelf_location` se fusionan en `shelf_id`.

```json
{
  "stop_id": "stp_9841a5b2",
  "route_date": "2026-11-24",
  "stop_number": 14,
  "sequence_order": 9,
  "stop_type": "delivery",
  "customer_name": "JANE DOE",
  "house_number": "4820",
  "street_address": "OLD RANCH RD",
  "address_line2": "APT 2",
  "city": "Springfield", "state": "MN", "zip": "55000",
  "address_confidence": "ocr_exact | completed_by_geocoder | manual",
  "house_lat_lng": { "latitude": 0, "longitude": 0 },
  "entry_lat_lng": { "latitude": 0, "longitude": 0 },
  "is_private_driveway": false,
  "driveway_distance_m": 0,
  "approach_side": "right | left | either",
  "shelf_id": "6000",
  "package_count": 1,
  "packages_checked": 0,
  "customer_notes": null,
  "visual_note": null,
  "entry_photo_url": null,
  "status": "pending | delivered | attempted | skipped"
}
```

## 6. Geocodificación y caminos privados

- **Casa** (`house_lat_lng`): el resultado del geocoder a nivel de techo (*rooftop*).
- **Entrada** (`entry_lat_lng`): el punto de navegación o de acceso a la vía que devuelve el proveedor (*navigation points* en Google, *routable points* en Mapbox).
- `driveway_distance_m` = distancia entre los dos puntos (Turf, o la fórmula de Haversine en Swift).
- Si la distancia pasa de un **umbral configurable (65 m por defecto)**, la parada se marca con `is_private_driveway = true`.
- Si el geocoder no da un resultado de techo, se marca *sin verificar* y la Fase 3 permite que el conductor fije el pin.

## 7. Motor de ruta

1. **Agrupar** las paradas pendientes en grupos de 10–15 por cercanía, con preferencia por mantener juntas las de la misma calle.
2. **Ordenar los grupos** usando sus centros, desde la ubicación actual o el punto de salida.
3. **Optimizar cada grupo** en paralelo. La salida de cada grupo es la última parada del grupo anterior. La restricción de lado de la calle (`sideOfRoad` / `approaches=curb`) solo se usa en modo *Strict*.
4. **Revisar las fronteras** con 2-opt local entre el final de un grupo y el inicio del siguiente.
5. **Lado derecho, según la configuración del conductor:**
   - *Off*: se ignora el lado; solo cuenta la distancia.
   - *Prefer* (por defecto): llegar a una parada por la izquierda suma una penalización al costo, pero un orden "por la derecha" solo gana si el desvío extra no pasa un tope (por ejemplo +10% o +300 m por tramo). Nunca se agrega una vuelta en U o una vuelta a la manzana solo para quedar a la derecha.
   - *Strict*: en una calle con paradas a ambos lados, primero las del lado derecho y las del otro lado al regresar.
   - En ningún modo aplica a calles sin salida, caminos privados, ni calles rurales de poco tráfico (se puede cruzar).
   - La nota del orden muestra cuánto cuesta la preferencia ("+0.4 mi por lado derecho") para que el conductor decida.
6. **Recalcular** cuando cambian las paradas (reasignación a media ruta o paradas completadas).

## 8. Modo manejo

- **Tarjeta de parada:** número de casa gigante, calle, barra verde LADO DERECHO, `Pkgs` y `SID`, notas del cliente, tarjeta ámbar si hay camino privado, y botones *Navegar* (abre Maps hacia `entry_lat_lng`) y *Siguiente*.
- **Geocercas (prototipo web):** `navigator.geolocation.watchPosition` + distancia a las próximas paradas con camino privado. Solo funciona con la PWA en primer plano y la pantalla encendida (Wake Lock). En segundo plano iOS suspende Safari: esto se resuelve en React Native, que permite máximo 20 regiones nativas a la vez, rotando las próximas N paradas.
- **Voz:** con `speechSynthesis` (web) / TTS nativo (React Native): "Entrada privada a 150 metros, a la derecha".
- La UI de interacción se usa con el vehículo detenido. En marcha, la app solo da alertas por voz y muestra la tarjeta.

## 9. Fases

### Fase 0: Base (≈1–2 días)
- [x] `git init` y `.gitignore` (incluye `docs/samples/`)
- [x] Monorepo con npm workspaces: `packages/core` y `apps/web` (React + Vite + TS)
- [x] `backend/` con FastAPI, endpoint `/health` y configuración por `.env`
- [x] `docker-compose.yml` con Postgres, Redis y almacenamiento S3 (RustFS)
- [x] Store de Redux Toolkit con un slice de ruta y una API de RTK Query
- [x] Fixtures: manifiesto sintético (PDF + PNG + JSON esperado) en `packages/core/fixtures`; las muestras reales quedan en `docs/samples/`, fuera de git
- [x] Llave de Google solo en `backend/.env`, fuera de git

### Fase 1: MVP
- [x] Importar capturas desde Fotos (multi-selección; OCR con Tesseract.js en el navegador, PSM 6, imagen escalada a ~2400 px)
- [x] Parser de Manifest View con pruebas sobre las fixtures (PDF ✅; capturas con OCR ✅: deduce números de parada perdidos y marca direcciones dudosas)
- [x] Pantalla de revisión: editar, eliminar, agregar a mano, "Looks right" y "Review next" sobre las marcas ámbar; la ruta se guarda en el teléfono (localStorage) y sobrevive a recargas
- [x] Configurar el área de ruta (ZIP o ciudad + estado; se guarda en el teléfono y sobrevive a "Clear route")
- [x] Geocodificación simple de la casa: `POST /api/geocode` con caché en Redis (30 días, llaves con hash). Proveedor: **US Census** (gratis, sin llave) por defecto, **Google** en cuanto haya `GOOGLE_MAPS_API_KEY`. Si una dirección no está en el ZIP del área, se reintenta en la ciudad de las demás paradas. Direcciones cortadas o ambiguas quedan en ámbar ("Check map match")
- [x] Orden optimizado, todavía sin restricción de lado: optimizador propio en `packages/core` (vecino más cercano + 2-opt + Or-opt, 150 paradas en milisegundos, funciona sin conexión) desde la parada actual. Distancia en línea recta, así que se compara contra el orden de GroundCloud y el conductor elige (toggle "GroundCloud # / Optimized"); solo cambia solo si sale más corto. No hacen falta tandas porque no depende de una API; las tandas vuelven si se usa Google Routes con distancias por calle (Fase 2)
- [ ] Tarjeta de parada en modo manejo (número gigante, lado derecho, paquetes); la versión básica ya está bajo el mapa
- [x] **Mapa de la ruta** (Leaflet + mosaicos de OpenStreetMap, sin llave): pines numerados, línea del recorrido desde la parada actual, actual en verde, dudosas en ámbar, completadas en gris; tarjeta de la parada actual con Navigate (Apple Maps), Google Maps, Delivered y Prev/Next. Hoy sigue el orden de GroundCloud (`#`); usará el orden optimizado cuando exista el motor de ruta
- **Listo cuando:** de 3–4 capturas de una ruta real sale una ruta ordenada en menos de 1 minuto y con 95% o más de direcciones correctas.

### Fase 2: Precisión en campo
- [x] Trazo real por calles en el mapa + millas y minutos de manejo de la ruta pendiente (`POST /api/routes/road-path`, Google Routes `computeRoutes`, en tramos de máx. 12 puntos para no pasar a la tarifa de más de 10 paradas intermedias, caché en Redis 7 días); sin llave se queda la línea recta punteada
- [x] Distancias reales por calle **en el optimizador** (`POST /api/routes/matrix`, Google Routes `computeRouteMatrix`): solo entre cada parada y sus 8 vecinas más cercanas, porque la matriz completa crece al cuadrado (120 paradas = 14,400 elementos); el resto se estima con la línea recta por la proporción típica calle/recta de la ruta. Una petición por origen con solo los destinos que necesita (se cobra por elemento), una dirección por par (simétrico), caché en Redis 30 días por par, así que "Re-optimize" solo paga los pares con la nueva posición del conductor. Sin llave o sin conexión, vuelve a la línea recta. La nota del orden dice "by road" o "straight-line"
- [x] **Negocios y pickups primero** (interruptor, activo por defecto): los negocios se detectan por el nombre del cliente y Address 2 (`looksLikeBusiness`), el conductor puede corregirlo por parada; el optimizador ordena primero ese grupo y después las casas desde donde terminó. Pines cuadrados en el mapa
- [x] Lado derecho **configurable** (selector *Any side / Prefer right / Right only*, se guarda en el teléfono). El lado se calcula con la casa (techo) y la entrada (en la calle) contra la dirección de llegada. En *Prefer*, cada llegada por la izquierda suma 150 m al costo y el orden se descarta si queda más de 10% más largo que el más corto; en *Strict*, 3,000 m. Se exentan caminos privados, paradas sin entrada y paradas sin otra a menos de 250 m. El optimizador hace una segunda búsqueda dirigida (2-opt que cuenta el sentido + Or-opt), arrancando del orden más corto y de un vecino más cercano con penalización. La nota del orden muestra las casas a la izquierda contra el orden de GroundCloud y las millas extra. La tarjeta dice "House on the RIGHT/LEFT" solo si se llega desde menos de 400 m. **Límite:** el rumbo de llegada es la línea recta desde la parada anterior; no conoce calles sin salida ni vueltas en U
- [x] Geocodificación dual y caminos privados: la casa sale de Geocoding v3 (techo) y la entrada del **Geocoding API v4 `SearchDestinations`** (punto de navegación DRIVE, preferido DROPOFF/PICKUP; el `navigation_points` de v3 ya no existe). Hay que tener habilitada la *Geocoding API* nueva en la llave. Sin entrada (Census, o falla v4) la parada sigue en el mapa, sin chequeo de camino. Umbral configurable (65 m por defecto). El mapa dibuja la entrada y la línea punteada ámbar a la casa; Navigate, el trazo y el optimizador usan la entrada. Caché de geocodificación pasó a `geocode:v2`
- [x] Geocercas y alertas de voz a 150 m (prototipo web): con GPS encendido se vigilan las 3 próximas paradas; al entrar a 150 m de la entrada de un camino privado se dice una vez "Private driveway in N meters, on the right/left. Stop N." (`speechSynthesis`) y se muestra en pantalla. Wake Lock mantiene la pantalla encendida. Se activa o desactiva en *Driving settings*; iOS pide un toque para habilitar la voz. **Falta:** probarlo manejando; en segundo plano no funciona (React Native)
- [x] Fuente 1 (PDF): el código ya lo importa (pdf.js, sin OCR). **Falta** confirmar con un PDF real de 🖨️ (D2)
- [x] Fuente 3 (grabación de la tarjeta de parada): un video de Fotos se lee en el navegador (un cuadro cada 0.75 s, se saltan los repetidos, OCR de cada uno). El parser busca la línea "DELIVERY | n PKG | SID" y toma la dirección arriba, y el nombre y las notas abajo. Una parada por dirección, con la mejor lectura. Como la tarjeta no muestra el `#`, se empareja con la ruta por dirección: completa la calle cortada, la ciudad, el ZIP y las notas del cliente ("CUST REQ…", visibles en la tarjeta). Si no hay coincidencia, la parada entra como nueva con el siguiente número y una marca de revisión. **Falta:** probar con una grabación real del iPhone; la muestra `stopcard_tablet_01.png` es de 410 px y no se puede leer
- [x] Fuente 6: foto de la etiqueta FedEx → código de barras u OCR → parada existente o nueva → mapa y ruta. Tarjeta "Box not on the manifest?": PDF417/MaxiCode con `zxing-wasm` (wasm servido desde la app, `textMode: 'Plain'`), respaldo OCR del bloque "TO"; coincide por rastreo ya escaneado o por dirección (número + calle, tolera abreviaturas y direcciones cortadas); permite "Go to stop", "+1 package" o parada nueva "From label", que se geocodifica con el ZIP de la etiqueta (`zip` por dirección en `/api/geocode`) y se inserta en el orden optimizado donde menos cuesta. **Falta:** probar con fotos de etiquetas reales (D6)

### Fase 3: Memoria del conductor y sincronización
- [ ] Pin doble editable (entrada y casa)
- [ ] Fotos y notas por dirección
- [ ] Backend y sincronización entre conductores de la misma ruta (Supabase o Firebase, por decidir)

## 9b. Despliegue (Docker)

- `backend/Dockerfile`: Python 3.13 slim, usuario sin privilegios y healthcheck en `/api/health`.
- `apps/web/Dockerfile`: se construye con Node desde la raíz del monorepo y se sirve con nginx, que manda `/api` a la API (mismo origen, sin CORS). Los assets se cachean un año y `index.html` no se cachea.
- `docker-compose.yml`: `docker compose up -d` levanta solo la infraestructura (Postgres, Redis, RustFS); `--profile app` levanta además la API y la web (puerto 8080).
- nginx vuelve a resolver el nombre `api` con el DNS de Docker, así que recrear el contenedor de la API no deja la web en 502.
- Los secretos van en `backend/.env` (`env_file`) en tiempo de ejecución, nunca dentro de la imagen.
- **Producción (`deploy/`):** `deploy/docker-compose.prod.yml` se suma al compose base. Caddy (`caddy:2.8.4-alpine`) va delante de nginx con HTTPS automático (Let's Encrypt; Safari lo exige para GPS, cámara y PWA) y *basic auth*, para que nadie más gaste la llave de Google. Postgres, Redis y RustFS quedan sin puertos publicados, con contraseñas de `deploy/.env` y la consola de RustFS apagada. `deploy/deploy.sh <host>` copia con rsync (sin `.env`, `docs/` ni fixtures) y reinicia. Probado en local: 401 sin clave, 200 con clave, HTTP → HTTPS.

## 10. Decisiones pendientes

| # | Pregunta | Recomendación |
|---|---|---|
| D0 | ~~¿SwiftUI nativo o Flutter?~~ | **Decidido:** prototipo web (React) + FastAPI + Postgres; luego React Native si convence |
| D1 | ¿Proveedor de mapas? (hoy: Census gratis; Google al poner la llave) | **Google Maps Platform**: Geocoding con *navigation points*, Routes con `sideOfRoad` y hasta 25 paradas por llamada, y Address Validation para direcciones cortadas. Mapbox v1 solo permite 12 coordenadas. Hay que revisar el costo con un volumen real. |
| D2 | ¿El PDF de 🖨️ trae texto real y direcciones completas? | El conductor lo prueba cuando tenga una ruta asignada |
| D3 | ¿Cómo se ve Manifest View en el iPhone, cuántas columnas y filas? | Pedir una captura desde el celular |
| D4 | ~~¿Backend?~~ | **Decidido:** FastAPI + PostgreSQL desde la Fase 0 |
| D5 | ¿Uso personal o producto para otros conductores? | Define cuentas, cobro y llaves de API detrás de un proxy |
| D7 | ~~MinIO ya no publica imágenes Docker~~ | **Decidido:** RustFS `1.0.4` (`rustfs/rustfs`), compatible con S3; la API crea el bucket al arrancar |
| D6 | ¿Qué código 2D traen las etiquetas reales de FedEx Ground y qué datos incluye? | Conseguir 2–3 fotos de etiquetas reales (con datos tapados) y probarlas con ZXing |

## 11. Riesgos

- **Manifest View puede no estar disponible** (sin ruta asignada o por configuración del contratista). Mitigación: las fuentes 3–5.
- **GroundCloud cambia su UI seguido** (rediseñó Manifest View en la versión 26.11.1). Mitigación: el parser se basa en los encabezados de columna, no en posiciones fijas, y hay pruebas con fixtures nuevas.
- **Calidad de las coordenadas en zonas rurales:** los resultados que no son de techo dan una distancia de acceso falsa. Mitigación: umbral configurable, marca de *sin verificar* y pin manual.
- **Términos de uso de GroundCloud y FedEx** sobre extraer datos del manifiesto. Hay que revisarlos antes de distribuir la app a otros.
- **Costo de las APIs** si se escala a muchos conductores.
