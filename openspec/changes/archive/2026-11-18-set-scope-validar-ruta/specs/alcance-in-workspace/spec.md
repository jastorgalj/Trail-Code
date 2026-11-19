## REMOVED Requirements

### Requirement: El in inyectado por set_scope funciona en las cuatro tools

**Reason**: `trail_set_scope` ya no mantiene estado entre llamadas (PR #30, `mcp-scope-sin-estado`).
El valor devuelto por `trail_set_scope` es un `in` sugerido para el cliente, no un scope inyectado
automáticamente; las cuatro tools sin `in` explícito no utilizan ningún scope guardado.

**Migration**: para acotar las cuatro tools a un sub-árbol, pasar `in` explícitamente en cada
llamada usando el valor devuelto por `trail_set_scope`.
