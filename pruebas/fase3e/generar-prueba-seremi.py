# Genera pruebas/datos-ficticios/prueba-seremi.json: una carpeta ficticia tipo "para subir a la SEREMI" con 98 archivos
# (subcarpetas, duplicados, versiones, imágenes, un escaneo sin texto, archivos con datos sensibles y relleno), una lista
# de 47 requisitos numerados y el resultado correcto para los requisitos 18 al 47 con la clasificación SEREMI.
# Todo es inventado. Comprueba que cada cita guionada existe tal cual en su documento.
import json, os, hashlib

REQ = {n: f"Requisito ficticio {n} de la pauta (no se revisa en esta prueba)." for n in range(1, 18)}
REQ.update({
 18: "Contar con una nómina del personal clínico con su cargo y jornada.",
 19: "Contar con un procedimiento escrito de lavado de manos clínico.",
 20: "Todo el personal clínico debe acreditar capacitación vigente en reanimación cardiopulmonar (RCP).",
 21: "Contar con un programa de mantención preventiva de los equipos láser.",
 22: "Contar con un protocolo de manejo de residuos especiales.",
 23: "Contar con un registro de esterilización de instrumental.",
 24: "Si se usan gases medicinales, contar con certificado de instalación de la red.",
 25: "Contar con un procedimiento de limpieza y desinfección de superficies.",
 26: "Contar con un plan de emergencia y evacuación firmado por el director técnico.",
 27: "Contar con un libro de reclamos y sugerencias foliado.",
 28: "Contar con un protocolo de atención de reacciones adversas.",
 29: "Si existe autoclave, contar con registro de operación del autoclave.",
 30: "Contar con un contrato vigente de retiro de residuos especiales con empresa autorizada.",
 31: "Contar con un manual de normas y procedimientos actualizado.",
 32: "Contar con un consentimiento informado tipo para cada procedimiento.",
 33: "Contar con un registro de notificación de enfermedades de declaración obligatoria (ENO).",
 34: "Contar con la carta de aceptación del director técnico firmada.",
 35: "Contar con un plano de evacuación visible en cada piso.",
 36: "Si existen instalaciones radiactivas, contar con su autorización sanitaria.",
 37: "Contar con un certificado de dotación de agua potable y alcantarillado.",
 38: "Contar con un protocolo de control de infecciones asociadas a la atención.",
 39: "Contar con un sistema de registros estadísticos mensuales.",
 40: "Contar con un procedimiento de manejo de quejas de pacientes.",
 41: "Contar con un botiquín de primeros auxilios con al menos 10 unidades de gasa estéril.",
 42: "Contar con certificaciones del personal para los procedimientos estéticos que realiza.",
 43: "Contar con el certificado de inscripción en la Superintendencia de Salud del personal.",
 44: "Contar con un procedimiento de calibración del equipo de depilación láser.",
 45: "Contar con un extintor de polvo químico seco vigente en cada piso.",
 46: "Contar con un protocolo de uso de elementos de protección personal.",
 47: "Contar con un manual de bioseguridad del establecimiento.",
})
# Subapartados (como en la guía real): quedan dentro de su número, no como requisitos aparte.
SUBS = {
 24: ["Si se usan gases medicinales, contar con certificado de instalación de la red.", "Si se usan gases medicinales, contar con un programa de mantención de la red."],
 34: ["Contar con la carta de aceptación del director técnico firmada.", "Contar con el certificado de título del director técnico."],
 35: ["Contar con un plano de evacuación visible en cada piso.", "Contar con señalética de vías de evacuación."],
 38: ["Contar con un protocolo de control de infecciones asociadas a la atención.", "Definir indicadores de vigilancia de infecciones.", "Designar un responsable del programa de infecciones.", "Registrar las capacitaciones del personal en prevención de infecciones."],
}
ENCAB = {24: "Gases medicinales:", 34: "Director técnico:", 35: "Evacuación:", 38: "Infecciones asociadas a la atención:"}
# 32 y 47 con el formato de la guía real (tabla convertida a texto): «-- 1 32 TÍTULO EN MAYÚSCULAS Texto…».
TITULO = {32: "CONSENTIMIENTO INFORMADO", 47: "MANUAL DE BIOSEGURIDAD"}
def linea(n):
    if n in TITULO: return f"-- 1 {n} {TITULO[n]} {REQ[n]}"
    if n in SUBS: return f"{n}. {ENCAB[n]}\n" + "\n".join(f"{chr(97 + i)}) {t}" for i, t in enumerate(SUBS[n]))
    return f"{n}. {REQ[n]}"
requisitos_doc = "REQUISITOS SEREMI — PAUTA FICTICIA PARA PRUEBAS\nDocumento ficticio. No corresponde a ninguna norma real.\nPágina 1\n" + "\n".join(
    (f"Página {2 if n == 18 else 3}\n" if n in (18, 33) else "") + linea(n) for n in range(1, 48)) + "\nNota final: la autoridad podrá solicitar antecedentes adicionales."

RELLENO = ["Este documento administrativo ficticio registra antecedentes generales sin relación con la pauta.",
           "Se adjuntan cotizaciones de mobiliario, facturas de compra y detalles de despacho del proveedor.",
           "La información de marketing describe campañas en redes sociales y promociones de temporada."]
def doc(t, secciones):
    out = [t.upper(), "Documento ficticio para pruebas."]
    for i, sec in enumerate(secciones, 1):
        out.append(f"Página {i}"); out += sec
    return "\n".join(out)

archivos = []
def agregar(id_, nombre, texto=None, mime="application/pdf", carpeta="carpeta-seremi", md5=None, fecha=None):
    archivos.append({"id": id_, "name": nombre, "mimeType": mime, "texto": texto, "parents": [carpeta],
                     "md5Checksum": md5 or hashlib.md5(((texto or "") + nombre).encode()).hexdigest()[:12], "version": 1,
                     **({"modifiedTime": fecha} if fecha else {})})

# Subcarpetas
carpetas = [{"id": "sub-certificados", "name": "Certificados", "mimeType": "application/vnd.google-apps.folder", "parents": ["carpeta-seremi"]},
            {"id": "sub-procedimientos", "name": "Procedimientos", "mimeType": "application/vnd.google-apps.folder", "parents": ["carpeta-seremi"]},
            {"id": "sub-otros", "name": "Otros", "mimeType": "application/vnd.google-apps.folder", "parents": ["sub-procedimientos"]}]

agregar("SREQ", "Requisitos SEREMI (ficticio).docx", requisitos_doc, mime="application/vnd.openxmlformats-officedocument.wordprocessingml.document")
# ---- Evidencia (raíz: lote 1) ----
agregar("A_NOMINA", "A01_Nomina_personal_clinico.pdf", doc("Nómina del personal clínico", [[
    "La nómina del personal clínico indica nombre, cargo y jornada de cada integrante: Dra. Ana Rojas, médico, 44 horas; Luis Pérez, técnico, 44 horas; Carla Soto, técnica, 22 horas.",
    "Certificados de RCP presentados: Ana Rojas vigente hasta 2027; Luis Pérez vigente hasta 2027."]]))
agregar("A_LAVADO", "A02_Procedimiento_lavado_manos.pdf", doc("Procedimiento de lavado de manos", [[
    "Procedimiento escrito de lavado de manos clínico: describe los cinco momentos, la técnica de lavado y el uso de solución alcohólica.",
    "Aprobado y vigente desde marzo de 2026."]]))
agregar("A_MANTLASER", "A03_Programa_mantencion_laser.pdf", doc("Programa de mantención", [[
    "Programa de mantención preventiva de los equipos láser: la próxima mantención está programada, pero el programa no indica la frecuencia ni el responsable."]]))
agregar("A_RESIDUOS", "A04_Protocolo_residuos.pdf", doc("Protocolo de residuos", [[
    "Protocolo de manejo de residuos especiales: clasificación, almacenamiento transitorio y entrega a empresa autorizada.",
    "El protocolo está aprobado por la dirección técnica."]]))
agregar("A_GASES", "A05_NO_APLICA_gases_medicinales.pdf", doc("Declaración no aplica", [[
    "El establecimiento no utiliza gases medicinales; por lo tanto, no cuenta con red de gases medicinales ni requiere certificado de instalación."]]))
agregar("A_LIMPIEZA", "A06_Limpieza_y_desinfeccion.pdf", doc("Limpieza y desinfección", [[
    "Procedimiento de limpieza y desinfección de superficies: frecuencia diaria, productos autorizados y registro de ejecución."]]))
agregar("A_EMERG", "A07_Plan_emergencia_evacuacion.pdf", doc("Plan de emergencia", [[
    "Plan de emergencia y evacuación del establecimiento, con rutas, zonas de seguridad y responsables.",
    "Firma del director técnico: (espacio para firma)."]]))
agregar("A_RECLAMOS", "A08_Libro_reclamos.pdf", doc("Libro de reclamos", [[
    "Libro de reclamos y sugerencias foliado, del folio 1 al 100, disponible en recepción."]]))
agregar("A_REACC", "A09_Protocolo_reacciones_adversas.pdf", doc("Reacciones adversas", [[
    "Protocolo de atención de reacciones adversas: el documento es un borrador sin fecha y le falta el flujo de derivación a urgencia."]]))
agregar("A_AUTOCLAVE", "A10_NO_APLICA_autoclave.pdf", doc("Declaración no aplica", [[
    "En el establecimiento no existe autoclave: todo el instrumental es desechable de un solo uso."]]))
# Contradicción (contrato de residuos): un documento dice vigente y otro vencido.
agregar("A_CONTRATO", "A11_Contrato_retiro_residuos.pdf", doc("Contrato de retiro", [[
    "Contrato de retiro de residuos especiales con empresa autorizada, vigente hasta diciembre de 2027."]]))
# ---- Sensibles (excluidos por defecto) ----
agregar("S_CEDULA", "Cedula_identidad_director_tecnico.pdf", doc("Cédula de identidad", [[
    "Cédula de identidad del director técnico. RUN 12.345.678-9. Fecha de nacimiento: 01/02/1980.",
    "Carta de aceptación del director técnico firmada, adjunta a su cédula."]]))
agregar("S_FICHA", "Ficha_clinica_paciente_ejemplo.pdf", doc("Ficha clínica", [["Ficha clínica de un paciente ficticio con diagnóstico ficticio."]]))
agregar("S_CI", "CI_consentimiento_botox.pdf", doc("Consentimiento informado", [["Consentimiento informado tipo para aplicación de toxina botulínica, con espacio para firma del paciente."]]))
# ---- No legibles por formato y escaneo sin texto ----
agregar("IMG_PLANO", "Plano_evacuacion_piso_1.jpg", None, mime="image/jpeg")
agregar("IMG_LOGO", "Logo_clinica.png", None, mime="image/png")
agregar("ZIP_FOTOS", "Fotos_instalaciones.zip", None, mime="application/zip")
agregar("PDF_ESCANEO", "Certificado_dotacion_agua_escaneado.pdf", "", md5="escaneo-vacio")
# ---- Duplicados exactos ----
agregar("DUP_LAVADO", "A02_Procedimiento_lavado_manos (1).pdf", archivos[2]["texto"], md5=archivos[2]["md5Checksum"])
agregar("DUP_RECLAMOS", "Copia de A08_Libro_reclamos.pdf", archivos[8]["texto"], md5=archivos[8]["md5Checksum"])
# ---- Subcarpeta Certificados (lotes intermedios/finales) ----
agregar("C_ESTETICA", "Certificaciones_procedimientos_esteticos.pdf", doc("Certificaciones", [[
    "Certificaciones del personal para los procedimientos estéticos: depilación láser y radiofrecuencia, todas vigentes."]]), carpeta="sub-certificados")
agregar("C_SIS", "Certificados_SIS_personal.pdf", doc("Certificados SIS", [["Certificados del personal emitidos por la Superintendencia de Salud. RUT 9.876.543-2."]]), carpeta="sub-certificados")
agregar("C_EXTINTOR", "Certificado_extintores.pdf", doc("Extintores", [[
    "Certificado de mantención: extintor de polvo químico seco vigente en el primer piso. El segundo piso no tiene extintor."]]), carpeta="sub-certificados")
# ---- Subcarpeta Procedimientos ----
agregar("P_MANUAL_V1", "Manual_normas_procedimientos_v1.pdf", doc("Manual de normas", [["Manual de normas y procedimientos, versión 2023, desactualizado: no incluye los procedimientos láser."]]), carpeta="sub-procedimientos", fecha="2023-05-10T12:00:00.000Z")
agregar("P_MANUAL_V2", "Manual_normas_procedimientos_v2_final.pdf", doc("Manual de normas", [["Manual de normas y procedimientos actualizado a septiembre de 2026, incluye todos los procedimientos del establecimiento."]]), carpeta="sub-procedimientos", fecha="2026-09-15T12:00:00.000Z")
agregar("P_INFECCIONES", "Protocolo_control_infecciones.pdf", doc("Control de infecciones", [[
    "Protocolo de control de infecciones asociadas a la atención, con vigilancia y medidas de prevención."]]), carpeta="sub-procedimientos")
agregar("P_ESTADISTICA", "Registros_estadisticos.pdf", doc("Registros estadísticos", [[
    "Sistema de registros estadísticos mensuales de atenciones, entregado a la autoridad cada mes."]]), carpeta="sub-procedimientos")
agregar("P_QUEJAS", "Procedimiento_quejas.pdf", doc("Quejas", [[
    "Procedimiento de manejo de quejas de pacientes: plazos de respuesta y registro."]]), carpeta="sub-procedimientos")
agregar("P_BOTIQUIN", "Inventario_botiquin.pdf", doc("Botiquín", [["Botiquín de primeros auxilios con 4 unidades de gasa estéril."]]), carpeta="sub-procedimientos")
agregar("P_EPP", "Protocolo_EPP.pdf", doc("EPP", [["Protocolo de uso de elementos de protección personal: guantes, mascarilla y protección ocular."]]), carpeta="sub-procedimientos")
agregar("P_BIOSEG", "Manual_bioseguridad.pdf", doc("Bioseguridad", [["Manual de bioseguridad del establecimiento, aprobado y vigente."]]), carpeta="sub-procedimientos")
# Al final (último lote): la tercera certificación de RCP (evidencia del 20 repartida en lotes distintos) y la contradicción del 30.
agregar("Z_RCP", "Z_Certificado_RCP_Carla_Soto.pdf", doc("Certificado RCP", [[
    "Certificado de capacitación en reanimación cardiopulmonar (RCP) de Carla Soto, vigente hasta 2027."]]), carpeta="sub-otros")
agregar("Z_ACTA", "Z_Acta_fiscalizacion.pdf", doc("Acta", [[
    "El contrato de retiro de residuos especiales se encuentra vencido desde 2025, según la fiscalización."]]), carpeta="sub-otros")
# Nombre con "pacientes" que NO es dato personal (procedimiento): debe auditarse, no excluirse.
agregar("A_TRASLADO", "A12_Traslado_de_pacientes.pdf", doc("Traslado de pacientes", [["Procedimiento de traslado de pacientes a un centro de mayor complejidad en caso de urgencia."]]))
# Archivos sensibles nombrados con el número de un requisito: excluidos, pero el requisito no puede quedar NO ENCONTRADO
# (33) ni HAY QUE MODIFICAR (41) sin revisarlos.
agregar("S_ENO", "33_Registro_pacientes_ENO.pdf", doc("Registro ENO", [["Registro de notificación ENO con nombres y RUT de pacientes."]]), carpeta="sub-otros")
agregar("S_BOT", "41_Listado_pacientes_curaciones.pdf", doc("Curaciones", [["Listado de pacientes atendidos en curaciones, con insumos utilizados."]]), carpeta="sub-otros")
# ---- Relleno hasta 98 archivos ----
i = 0
while len(archivos) < 98:
    i += 1
    carpeta = ["carpeta-seremi", "sub-certificados", "sub-procedimientos", "sub-otros"][i % 4]
    agregar(f"R{i:03d}", f"M{i:03d}_Documento_administrativo.pdf", doc(f"Documento administrativo {i}", [[RELLENO[i % 3], f"Registro interno número {i} de la oficina de administración."]]), carpeta=carpeta)

txt = {a["id"]: a["texto"] for a in archivos}
E = {  # resultado correcto (estado técnico, clasificación SEREMI) y respuesta guionada del Claude simulado
 "18": ("cumple", "listo", [("A_NOMINA", "La nómina del personal clínico indica nombre, cargo y jornada de cada integrante", "a_favor")], "Subir la nómina tal como está."),
 "19": ("cumple", "listo", [("A_LAVADO", "Procedimiento escrito de lavado de manos clínico", "a_favor")], "Subir el procedimiento tal como está."),
 "20": ("cumple", "listo", [("A_NOMINA", "Certificados de RCP presentados: Ana Rojas vigente hasta 2027; Luis Pérez vigente hasta 2027", "a_favor"), ("Z_RCP", "Certificado de capacitación en reanimación cardiopulmonar (RCP) de Carla Soto, vigente hasta 2027", "a_favor")], "Subir la nómina junto con el certificado de RCP de Carla Soto."),
 "21": ("parcial", "modificar", [("A_MANTLASER", "el programa no indica la frecuencia ni el responsable", "en_contra")], "Agregar al programa la frecuencia de mantención y el responsable, y volver a firmarlo."),
 "22": ("cumple", "listo", [("A_RESIDUOS", "Protocolo de manejo de residuos especiales", "a_favor")], "Subir el protocolo tal como está."),
 "23": None,  # sin evidencia → NO ENCONTRADO (código)
 "24": ("no_aplica_justificado", "no_aplica", [("A_GASES", "El establecimiento no utiliza gases medicinales", "a_favor")], "Subir la declaración de no aplica firmada."),
 "25": ("cumple", "listo", [("A_LIMPIEZA", "Procedimiento de limpieza y desinfección de superficies", "a_favor")], "Subir el procedimiento tal como está."),
 "26": ("cumple", "revisar", [("A_EMERG", "Plan de emergencia y evacuación del establecimiento", "a_favor")], "Verificar visualmente que el plan tenga la firma del director técnico antes de subirlo."),
 "27": ("cumple", "listo", [("A_RECLAMOS", "Libro de reclamos y sugerencias foliado", "a_favor")], "Subir el libro tal como está."),
 "28": ("parcial", "modificar", [("A_REACC", "el documento es un borrador sin fecha y le falta el flujo de derivación a urgencia", "en_contra")], "Completar el flujo de derivación a urgencia, fechar el protocolo y aprobarlo."),
 "29": ("no_aplica_justificado", "no_aplica", [("A_AUTOCLAVE", "En el establecimiento no existe autoclave", "a_favor")], "Subir la declaración de no aplica firmada."),
 "30": ("contradictorio", "revisar", [("A_CONTRATO", "Contrato de retiro de residuos especiales con empresa autorizada, vigente hasta diciembre de 2027", "a_favor"), ("Z_ACTA", "El contrato de retiro de residuos especiales se encuentra vencido desde 2025", "en_contra")], "Confirmar con la empresa la vigencia del contrato y subir la versión vigente."),
 "31": ("cumple", "listo", [("P_MANUAL_V2", "Manual de normas y procedimientos actualizado a septiembre de 2026", "a_favor")], "Subir la versión 2 del manual y no la versión 1."),
 "32": None,  # el consentimiento tipo está excluido por sensible → no encontrado entre lo auditado
 "33": None,
 "34": None,  # la carta está dentro de la cédula (excluida) → no encontrado
 "35": None,  # solo hay un plano en imagen → REQUIERE REVISIÓN (código)
 "36": None,
 "37": None,  # solo un escaneo sin texto → REQUIERE REVISIÓN (código)
 "38": ("parcial", "modificar", [("P_INFECCIONES", "Protocolo de control de infecciones asociadas a la atención", "a_favor")], "Completar los subapartados b, c y d: indicadores de vigilancia, responsable del programa y registro de capacitaciones."),
 "39": ("cumple", "listo", [("P_ESTADISTICA", "Sistema de registros estadísticos mensuales de atenciones", "a_favor")], "Subir el documento tal como está."),
 "40": ("cumple", "listo", [("P_QUEJAS", "Procedimiento de manejo de quejas de pacientes", "a_favor")], "Subir el procedimiento tal como está."),
 "41": ("no_cumple", "modificar", [("P_BOTIQUIN", "Botiquín de primeros auxilios con 4 unidades de gasa estéril", "en_contra")], "Reponer el botiquín hasta tener al menos 10 unidades de gasa estéril y actualizar el inventario."),
 "42": ("cumple", "listo", [("C_ESTETICA", "Certificaciones del personal para los procedimientos estéticos", "a_favor")], "Subir las certificaciones tal como están."),
 "43": ("cumple", "listo", [("C_SIS", "Certificados del personal emitidos por la Superintendencia de Salud", "a_favor")], "Subir los certificados tal como están."),  # solo si lo incluyes; si no, REQUIERE REVISIÓN por el nombre
 "44": None,
 "45": ("parcial", "modificar", [("C_EXTINTOR", "extintor de polvo químico seco vigente en el primer piso", "a_favor"), ("C_EXTINTOR", "El segundo piso no tiene extintor", "en_contra")], "Instalar un extintor vigente en el segundo piso y actualizar el certificado."),
 "46": ("cumple", "listo", [("P_EPP", "Protocolo de uso de elementos de protección personal", "a_favor")], "Subir el protocolo tal como está.", "que el protocolo esté completo: el texto parece terminar a mitad de la lista"),
 "47": ("cumple", "listo", [("P_BIOSEG", "Manual de bioseguridad del establecimiento, aprobado y vigente", "a_favor")], "Subir el manual tal como está."),
}
CODIGO = {"23": "no_encontrado", "32": "revisar", "33": "revisar", "34": "revisar", "35": "revisar", "36": "no_encontrado", "37": "revisar", "43": "no_encontrado", "44": "no_encontrado"}
for rid, v in E.items():
    if v:
        for (aid, cita, _) in v[2]: assert cita in txt[aid], (rid, aid, cita)
for n in range(18, 48): assert (all(t in requisitos_doc for t in SUBS[n]) if n in SUBS else REQ[n] in requisitos_doc)
correcto = []
# El código corrige "listo" cuando falta comprobar algo: 31 (hay dos versiones del manual) y 46 (la IA dejó algo por verificar).
FINAL = {"31": "revisar", "46": "revisar", "41": "revisar"}  # 41: la IA diría "modificar", pero hay un archivo omitido con su número
for rid, v in E.items():
    if v: correcto.append({"id": rid, "estado": v[0], "presentacion": FINAL.get(rid, v[1]), "archivos": sorted(set(e[0] for e in v[2]))})
    else: correcto.append({"id": rid, "estado": "sin_evidencia", "presentacion": CODIGO[rid], "archivos": []})
salida = {
 "_nota": "Prueba SEREMI (Fase 3e a escala): 98 archivos ficticios en una carpeta con subcarpetas, 47 requisitos numerados y resultado correcto para el 18 al 47. Todo es inventado. Generado por pruebas/fase3e/generar-prueba-seremi.py.",
 "carpetas": carpetas, "archivos": archivos, "norma_id": "SREQ",
 "resultado_correcto": correcto,  # con «Certificados_SIS_personal.pdf» incluido por decisión expresa
 "resultado_sin_sensibles": {"43": "revisar"},  # si no se incluye ningún archivo sensible, solo cambia el 43
 "simulado": {
   # Lo que devuelve la extracción simulada: subapartados como ítems "24 a)", "24 b)"… (como pasó con la guía real).
   # Con FAKE_H_EXTRACCION_OMITIR=32,47 la IA simulada además se salta esos números (se recuperan del texto).
   "requisitos": [x for n in range(1, 48) for x in ([{"referencia": f"{n} {chr(97 + i)})", "texto": t, "cita": t} for i, t in enumerate(SUBS[n])] if n in SUBS else [{"referencia": str(n), "texto": REQ[n], "cita": REQ[n]}])],
   "evaluaciones": {rid: {"estado": v[0], "presentacion": v[1], "evidencias": [{"cita": c, "aporta": a} for (_, c, a) in v[2]], "justificacion": f"Evaluación simulada del requisito {rid}.", "accion": v[3], **({"pendiente_verificar": v[4]} if len(v) > 4 else {})} for rid, v in E.items() if v},
 },
}
json.dump(salida, open("pruebas/datos-ficticios/prueba-seremi.json", "w"), ensure_ascii=False, indent=1)
from collections import Counter
print("archivos", len(archivos), Counter(x["presentacion"] for x in correcto))
