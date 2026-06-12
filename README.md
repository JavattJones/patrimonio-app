# 💶 Patrimonio

PWA personal para llevar el control del patrimonio mes a mes: saldos de todas las cuentas,
aportaciones a brokers (sin valorar el mercado) y gráficas de evolución y ahorro.

**App:** https://javattjones.github.io/patrimonio-app/

- El código de este repo es público pero **no contiene ningún dato**.
- Los datos viven en un **repo privado** (`patrimonio-data`) y viajan directamente
  entre tu dispositivo y GitHub por HTTPS.
- Funciona sin servidor propio y sin que el PC esté encendido.

---

## Instalación en el iPhone

1. Abre **Safari** y entra en `https://javattjones.github.io/patrimonio-app/`
2. Botón **Compartir** (cuadrado con flecha) → **Añadir a pantalla de inicio**
3. Ya tienes "Patrimonio" como una app más, a pantalla completa.

En el PC: abre la misma URL en el navegador (se puede "instalar" desde el icono de la
barra de direcciones en Chrome/Edge).

## Configuración inicial (una sola vez por dispositivo)

### 1. Crear el token

1. GitHub → **Settings → Developer settings → Fine-grained personal access tokens → Generate new token**
   (directo: https://github.com/settings/personal-access-tokens/new)
2. **Token name:** `patrimonio` · **Expiration:** 1 año (o el máximo)
3. **Repository access:** *Only select repositories* → elige **`patrimonio-data`**
4. **Permissions → Repository permissions → Contents: Read and write**
5. Generate token → copia el `github_pat_…`

### 2. Conectar la app

En la app → **Ajustes → Sincronización (GitHub)**:

| Campo | Valor |
|---|---|
| Usuario | `JavattJones` |
| Repositorio | `patrimonio-data` |
| Token | el `github_pat_…` copiado |

Pulsa **Guardar y probar**. El token se guarda solo en ese dispositivo
(hay que repetir este paso en cada dispositivo: iPhone y PC).

### 3. Crear las cuentas

En **Ajustes → Cuentas**, añade cada sitio donde tienes dinero:

- **Cuenta / banco** — registras el saldo cada mes (BBVA, efectivo…)
- **Inversión** — registras el saldo mensual y defines el capital aportado,
  para ver si vas en + o − respecto a lo que metiste (MindBest, OpenVan, Arcadeo…)
- **Solo aportaciones** — cuenta únicamente por lo que aportas, sin valorar
  el mercado (IBKR: el rendimiento ya lo lleva otro sistema)

## Uso mensual (día 1, ~5 min)

1. Abre la app → pestaña **Actualizar**
2. Mete el saldo de cada cuenta (te muestra el del mes anterior como referencia)
3. Opcional: ingresos del mes (para estimar el gasto) y una nota
4. **Guardar mes** → el Resumen se actualiza con las gráficas

## Métricas del Resumen

- **Patrimonio total** del último mes registrado
- **Ahorro del mes** = total actual − total del mes anterior
- **Gasto estimado** = ingresos − ahorro (si registraste ingresos)
- **Media de ahorro/mes** y **variación a 12 meses**
- **Evolución** (línea) y **ahorro mensual** (barras ±)
- Por cuenta de inversión: **diferencia vs. capital aportado**

## Copia de seguridad

Además del historial completo que guarda Git en `patrimonio-data` (cada
actualización es un commit), puedes exportar/importar el JSON desde **Ajustes**.
