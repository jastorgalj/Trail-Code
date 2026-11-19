## Purpose

Validación de ruta de `trail_set_scope`: rechaza paths con `..`, inexistentes o no-directorio, y
compara la raíz sin distinguir mayúsculas en Windows.

## ADDED Requirements

### Requirement: Rechazo de segmentos `..`

`trail_set_scope` SHALL rechazar con `isError: true` cualquier path que contenga un segmento `..`
tras normalizar los separadores de directorio (`\` → `/`). La normalización elimina barras finales
pero no resuelve `..`.

#### Scenario: path con segmento `..`

GIVEN un servidor MCP arrancado sobre `/w`
WHEN se llama `trail_set_scope` con `{ "path": "/w/foo/../bar" }`
THEN la respuesta es `isError: true` y su texto contiene `".." segments`

### Requirement: Rechazo de rutas que no son un directorio existente

`trail_set_scope` SHALL rechazar con `isError: true` cualquier path que no exista o exista pero no
sea un directorio.

#### Scenario: path que no existe

GIVEN un servidor MCP arrancado sobre `/w`
WHEN se llama `trail_set_scope` con `{ "path": "/w/no-existe" }` y `/w/no-existe` no existe
THEN la respuesta es `isError: true` y su texto contiene `is not an existing directory`

#### Scenario: path que es un archivo

GIVEN un servidor MCP arrancado sobre `/w` y un archivo `/w/file.ts`
WHEN se llama `trail_set_scope` con `{ "path": "/w/file.ts" }`
THEN la respuesta es `isError: true` y su texto contiene `is not an existing directory`

### Requirement: Comparación de raíz sin distinguir mayúsculas en Windows

En Windows (donde el sistema de archivos es case-insensitive), `trail_set_scope` SHALL comparar la
raíz del servidor contra el path recibido sin distinguir mayúsculas en la letra de unidad y el
prefijo de la raíz.

#### Scenario: c:/ vs C:/ en caseInsensitive

GIVEN un servidor MCP arrancado sobre `C:/workspace` en Windows
WHEN se llama `trail_set_scope` con `{ "path": "c:/workspace/src" }` y `src` es un directorio existente
THEN la respuesta es `isError: false` y su texto contiene `pass in: "src"`

#### Scenario: c:/ vs C:/ en sistema case-sensitive

GIVEN un servidor MCP arrancado sobre `C:/workspace` en un sistema case-sensitive
WHEN se llama `trail_set_scope` con `{ "path": "c:/workspace/src" }` (distinta mayúscula)
THEN la respuesta es `isError: true` y su texto contiene `is not under the server workspace`
