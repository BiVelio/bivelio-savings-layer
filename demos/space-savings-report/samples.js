const SAMPLES = {
  cachePrefix: {
    titulo: "Reorden del prefijo cacheable — A/B en vivo",
    contexto:
      "20 peticiones por brazo contra claude-haiku-4-5, mismas timestamps. Brazo A: el timestamp viaja DENTRO del prefijo marcado. Brazo B: savings.cachePrefix mueve el timestamp fuera y marca solo la parte estable. Contadores del proveedor (cache_read/cache_creation), precios de lista.",
    filas: [
      ["A · sin cachePrefix", "0.166225", "0", "126,260", "0 %"],
      ["B · con cachePrefix", "0.028658", "119,567", "6,293", "95 %"],
    ],
    lectura:
      "Arm A: el prefijo cambia en cada petición → hit-rate ~0 y la escritura completa (1,25×) se paga siempre. Arm B: la primera petición escribe la parte estable y las N−1 siguientes la LEEN a 0,1×. <b>−82,76 % de coste por petición</b>; el ahorro es del proveedor (su caché acierta), y el informe lo muestra en su libro aparte.",
    enlace: "benchmarks/evidencia/cache-prefix-vivo-2026-11-15.json",
  },
  factorial: {
    titulo: "Factorial dedup × cache_control (2×2)",
    contexto:
      "Las mismas 12 preguntas y 12 repeticiones en las 4 celdas de claude-haiku-4-5, con sal por celda para aislar las cachés. Dedup = política de caché exacta del arnés en vivo.",
    filas: [
      ["off · off", "0.178171", "0"],
      ["off · on", "0.031128", "0"],
      ["on · off", "0.119482", "8"],
      ["on · on", "0.025044", "7"],
    ],
    lectura:
      "Reducción combinada <b>−85,94 %</b>; interacción de coste IC = C11−C10−C01+C00 = <b>+$0,0526</b> (las llamadas evitadas no pueden leer la caché). Descomposición algebraica de los totales registrados — exploratorio, no causal.",
    enlace: "benchmarks/evidencia/factorial-vivo-2026-11-15.json",
  },
  cascada: {
    titulo: "Piloto de coste de la cascada (exploratorio)",
    contexto:
      "24 preguntas de respuesta única con lista dorada. Brazo A: claude-opus-5-5 siempre. Brazo B: modelCascade «on» → haiku-4-5 con verja; escaladas: 0. Juez exacto con aceptadas declaradas; respuestas publicadas.",
    filas: [
      ["A · sin cascada (24/24 aciertos)", "0.064568", "—"],
      ["B · con cascada (24/24 aciertos, 23/24 acuerdo)", "0.020718", "—"],
    ],
    lectura:
      "<b>−67,91 % de coste</b>, 24/24 aciertos en ambos brazos y 23/24 de acuerdo normalizado. Piloto exploratorio: NO es una prueba de no-inferioridad (sin margen δ prespecificado). Cada respuesta está publicada para regrado independiente.",
    enlace: "benchmarks/evidencia/cascada-piloto-corregido-2026-11-15.json",
  },
  rho: {
    titulo: "Curva ρ — ahorro frente a repetición exacta",
    contexto:
      "gpt-4o-mini, 20 preguntas únicas + ⌊20q⌋ repeticiones. q es repeticiones POR única; la fracción real entre todas las peticiones es ⌊20q⌋/(20+⌊20q⌋).",
    filas: [
      ["q = 0,3 · 26 peticiones · 23,08 % reales", "—", "14,67 %"],
      ["q = 0,6 · 32 peticiones · 37,50 % reales", "—", "23,67 %"],
    ],
    lectura:
      "Con 23,08 % de repeticiones reales → <b>14,67 %</b>; con 37,50 % → <b>23,67 %</b>. Dos puntos exploratorios, no una curva calibrada: los totales redondeados no reproducen los ratios exactos (publicar sin redondear queda anotado como tarea).",
    enlace: "benchmarks/evidencia/rho-vivo-2026-11-15.json",
  },
};
