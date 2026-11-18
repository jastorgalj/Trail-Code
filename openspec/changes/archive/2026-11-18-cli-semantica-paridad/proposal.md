## Why

`trail ask --semantic` en la CLI tenía su propia copia de la búsqueda federada y, con ella, los tres defectos que #19 corrigió en el MCP (`trail_search_semantic`): el `catch` vacío convertía un índice ilegible en «no semantic matches found», cada hijo sin `embeddings.db` se saltaba en silencio y `--in` se ignoraba, así que `--in repoB` respondía con hits de todos los repos.

## What Changes

- La rama `--semantic` de `trail ask` usa `federateSemantic` en modo workspace, en vez de una segunda implementación: mismo `in`, misma nota de cobertura, mismo reporte de fallos por hijo.
- La CLI separa los dos canales que el MCP tiene que mezclar: hits en stdout; cobertura y fallos en stderr.
- Exit code: sin coincidencias, sin índice o con la búsqueda fallida → `1`. Un diagnóstico nunca se imprime como si fuera una lista vacía de resultados.
- Repo único: se elimina el `catch` vacío; un índice ilegible reporta `semantic search failed: <mensaje>`, y la ausencia de índice se distingue de la ausencia de coincidencias.

## Fuera de alcance

- El umbral de relevancia (`score > 0.05`) del camino de repo único se conserva tal cual: este change no toca el scoring, sólo cómo se reportan los estados. El camino de workspace queda sin umbral porque su contrato es el del MCP, que tampoco lo aplica.
- `--json` no aplica a `--semantic` (ya era así): no hay forma JSON de un resultado semántico en la CLI, y agregarla es otro cambio.

## Capabilities

### New Capabilities

Ninguna.

### Modified Capabilities

- `busqueda-semantica-workspace`: el comportamiento federado que ya enunciaba para la tool MCP se extiende a la superficie CLI, que hasta ahora no estaba especificada.
