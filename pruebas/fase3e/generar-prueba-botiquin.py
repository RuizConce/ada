# Genera pruebas/datos-ficticios/prueba-botiquin.json: encargo ficticio «organizar el expediente de un botiquín».
# Carpeta de requisitos (con el PDF de 22 requisitos numerados) y carpeta de documentos (46 archivos): un archivo que
# acredita dos requisitos, un requisito con dos archivos, documentos parciales, una declaración de no aplica con su
# razón, un archivo con nombre engañoso (sin evidencia), una imagen, un acceso directo, un duplicado y un archivo
# sensible. Todo es inventado.
import json, hashlib
REQ = {
 1: "Solicitud de autorización de botiquín firmada por el representante legal.",
 2: "Fotocopia del RUT de la empresa (rol único tributario).",
 3: "Escritura de constitución de la sociedad.",
 4: "Nombramiento del químico farmacéutico responsable del botiquín.",
 5: "Contrato de trabajo del químico farmacéutico responsable.",
 6: "Título profesional del químico farmacéutico.",
 7: "Plano del local del botiquín con sus medidas.",
 8: "Listado de medicamentos que mantendrá el botiquín.",
 10: "Registro de control de temperatura del refrigerador de medicamentos.",
 11: "Procedimiento de eliminación de medicamentos vencidos.",
 12: "Si se manejan estupefacientes, libro de control de estupefacientes.",
 13: "Horario de funcionamiento del botiquín.",
 14: "Procedimiento de dispensación de medicamentos a pacientes.",
 15: "Certificado de calibración del termómetro del refrigerador.",
 16: "Programa de capacitación del personal del botiquín.",
 17: "Procedimiento de control de inventario de medicamentos.",
 18: "Declaración de cumplimiento de condiciones sanitarias del local, firmada.",
 19: "Certificado de dotación de agua potable del local.",
 20: "Procedimiento de manejo de reclamos de usuarios.",
 21: "Póliza de seguro del local.",
 22: "Procedimiento de limpieza del área del botiquín.",
}
# Estructura del PDF real: tabla «N.º | Requisito | Qué subir para Andaluz | Estado» (1–9 en la página 1, 10–22 en la
# página 2 con el encabezado repetido) y una página 3 con datos base y pendientes numerados (no son requisitos).
REQ[9] = "Procedimientos de recepción y almacenamiento de medicamentos."
ESTADO = {n: "Listo" for n in (2, 3, 4, 8, 9, 10, 17, 18, 19, 20)}
ESTADO.update({n: "Por preparar" for n in (1, 5, 12, 15, 16, 21)}); ESTADO.update({n: "No aplica" for n in (6, 7, 11, 13, 14, 22)})
CAB = ["N.º", "Requisito", "Qué subir para Andaluz", "Estado"]
def celdas(n):
    subir = "El documento correspondiente de Andaluz, legible y completo."
    if n == 12: return [str(n), REQ[n], "Copias:", "2", subir, ESTADO[n]]    # «2» suelto dentro de una celda
    if n == 4: return [str(n), "Nombramiento del químico farmacéutico", "responsable del botiquín.", subir, ESTADO[n]]  # celda en dos líneas
    if n == 5: return [str(n), "Contrato de trabajo del químico", "farmacéutico responsable.", subir, ESTADO[n]]  # título partido (minúscula)
    if n == 7: return [str(n), "Plano del local del", "botiquín con sus medidas.", subir, ESTADO[n]]  # título partido tras «del»
    if n == 9: return [str(n), REQ[n], subir, ESTADO[n] + " Page 1 of 3 Botiquín Andaluz — requisitos y documentos"]  # pie pegado al estado
    return [str(n), REQ[n], subir, ESTADO[n]]
norma = "\n".join(["BOTIQUÍN ANDALUZ — REQUISITOS Y DOCUMENTOS (FICTICIO)", *CAB, *[c for n in range(1, 10) for c in celdas(n)], *CAB, *[c for n in range(10, 23) for c in celdas(n)], "Page 2 of 3", "Botiquín Andaluz — requisitos y documentos",
  "DATOS BASE DEL BOTIQUÍN", "Nombre: Botiquín Andaluz (ficticio)", "Representante legal: Juan Pérez Soto, RUT 12.345.678-9, teléfono +56 9 1234 5678, correo juan.perez@ejemplo.cl",
  "Pendientes", "1. Firmar la solicitud.", "2. Conseguir la póliza de seguro.", "3. Completar el procedimiento de almacenamiento."])
archivos = []
def agregar(id_, nombre, texto=None, mime="application/pdf", carpeta="carpeta-botdocs", md5=None):
    archivos.append({"id": id_, "name": nombre, "mimeType": mime, "texto": texto, "parents": [carpeta], "version": 1,
                     "md5Checksum": md5 or hashlib.md5(((texto or "") + nombre).encode()).hexdigest()[:12]})
def doc(t, lineas): return t.upper() + "\nDocumento ficticio.\nPágina 1\n" + "\n".join(lineas)
carpetas = [{"id": "carpeta-botreq", "name": "Botiquin_requisitos", "mimeType": "application/vnd.google-apps.folder", "parents": ["root"]},
            {"id": "carpeta-botdocs", "name": "Botiquin_documentos", "mimeType": "application/vnd.google-apps.folder", "parents": ["root"]},
            {"id": "botdocs-procedimientos", "name": "Procedimientos", "mimeType": "application/vnd.google-apps.folder", "parents": ["carpeta-botdocs"]}]
agregar("BREQ", "00.Botiquín Andaluz — requisitos y documentos.pdf", norma, carpeta="carpeta-botreq")
agregar("BREQ_OTRO", "Notas_internas.pdf", doc("Notas", ["Notas sin relación."]), carpeta="carpeta-botreq")
T = {
 "D_SOLICITUD": ("Solicitud_autorizacion_botiquin.pdf", ["Solicitud de autorización de botiquín presentada por el representante legal de la empresa.", "Firma del representante legal: (espacio para firma)."]),
 "D_RUT": ("RUT_empresa.pdf", ["Fotocopia del RUT de la empresa: rol único tributario 76.123.456-7."]),
 "D_ESCRITURA": ("Escritura_constitucion_sociedad.pdf", ["Escritura pública de constitución de la sociedad Clínica Ficticia SpA, otorgada ante notario."]),
 "D_QF": ("Contrato_QF_y_nombramiento.pdf", ["Nombramiento del químico farmacéutico responsable del botiquín: Q.F. Ana Soto.", "Contrato de trabajo del químico farmacéutico responsable, jornada de 44 horas."]),
 "D_TITULO": ("Titulo_QF.pdf", ["Título profesional de químico farmacéutico otorgado por la Universidad Ficticia."]),
 "D_PLANO": ("Plano_local_botiquin.jpg", None),
 "D_LISTADO": ("Listado_medicamentos.pdf", ["Listado de medicamentos que mantendrá el botiquín: paracetamol, ibuprofeno y suero fisiológico."]),
 "D_RECEPCION": ("Procedimiento_recepcion.pdf", ["Procedimiento de recepción de medicamentos: revisión de guía de despacho, lote y vencimiento."]),
 "D_TEMP1": ("Registro_temperatura_enero.pdf", ["Registro de control de temperatura del refrigerador de medicamentos: lecturas diarias de enero de 2026."]),
 "D_TEMP2": ("Registro_temperatura_febrero.pdf", ["Registro de control de temperatura del refrigerador de medicamentos: lecturas diarias de febrero de 2026."]),
 "D_VENCIDOS": ("Eliminacion_vencidos.pdf", ["Procedimiento de eliminación de medicamentos vencidos mediante empresa autorizada."]),
 "D_NOESTUP": ("NO_APLICA_estupefacientes.pdf", ["El botiquín no maneja estupefacientes ni psicotrópicos; por eso no lleva libro de control de estupefacientes."]),
 "D_HORARIO": ("Horario_funcionamiento.pdf", ["Horario de funcionamiento del botiquín: lunes a viernes de 9 a 18 horas."]),
 "D_DISPENSA": ("Procedimiento_dispensacion.pdf", ["Procedimiento de dispensación de medicamentos a pacientes con receta y registro."]),
 "D_SENUELO": ("Certificado_calibracion_termometro.pdf", ["Cotización de mobiliario para la sala de espera: tres sillas y una mesa."]),
 "D_CAPAC": ("Programa_capacitacion.pdf", ["Programa de capacitación del personal del botiquín: buenas prácticas de almacenamiento y dispensación."]),
 "D_INVENT": ("Control_inventario.pdf", ["Procedimiento de control de inventario de medicamentos con conteo mensual."]),
 "D_DECLARA": ("Declaracion_condiciones_sanitarias.pdf", ["Declaración de cumplimiento de condiciones sanitarias del local del botiquín.", "Firma: pendiente."]),
 "D_AGUA": ("Certificado_agua_potable.pdf", ["Certificado de dotación de agua potable del local emitido por la empresa sanitaria."]),
 "D_RECLAMOS": ("Procedimiento_reclamos.pdf", ["Procedimiento de manejo de reclamos de usuarios con respuesta en cinco días hábiles."]),
 "D_LIMPIEZA": ("Procedimiento_limpieza.pdf", ["Procedimiento de limpieza del área del botiquín, diario, con registro."]),
}
for i, (k, (nombre, lineas)) in enumerate(T.items()):
    if lineas is None: agregar(k, nombre, None, mime="image/jpeg")
    else: agregar(k, nombre, doc(nombre.split(".")[0].replace("_", " "), lineas), carpeta="botdocs-procedimientos" if i % 3 == 0 else "carpeta-botdocs")
recl = next(a for a in archivos if a["id"] == "D_RECLAMOS")
agregar("D_RECLAMOS_COPIA", "Copia de Procedimiento_reclamos.pdf", recl["texto"], md5=recl["md5Checksum"])
archivos.append({"id": "D_ATAJO", "name": "Acceso directo a otro botiquín", "mimeType": "application/vnd.google-apps.shortcut", "parents": ["carpeta-botdocs"], "version": 1, "shortcutDetails": {"targetId": "BREQ_OTRO"}})
i = 0
while len([a for a in archivos if a["parents"][0] != "carpeta-botreq"]) < 46:
    i += 1
    agregar(f"D_R{i:02d}", f"Administrativo_{i:02d}.pdf", doc(f"Administrativo {i}", [f"Factura de compra número {i} de insumos de oficina."]), carpeta="carpeta-botdocs" if i % 2 else "botdocs-procedimientos")
txt = {a["id"]: a.get("texto") for a in archivos}
# Respuesta guionada del Claude simulado (estado, clasificación, evidencias, acción) y el resultado correcto final.
E = {
 "1": ("cumple", "listo", [("D_SOLICITUD", "Solicitud de autorización de botiquín presentada por el representante legal de la empresa.", "a_favor")], "Subir la solicitud."),
 "2": ("cumple", "listo", [("D_RUT", "Fotocopia del RUT de la empresa: rol único tributario", "a_favor")], "Subir la fotocopia del RUT."),
 "3": ("cumple", "listo", [("D_ESCRITURA", "Escritura pública de constitución de la sociedad Clínica Ficticia SpA", "a_favor")], "Subir la escritura."),
 "4": ("cumple", "listo", [("D_QF", "Nombramiento del químico farmacéutico responsable del botiquín: Q.F. Ana Soto.", "a_favor")], "Subir el nombramiento."),
 "5": ("cumple", "listo", [("D_QF", "Contrato de trabajo del químico farmacéutico responsable, jornada de 44 horas.", "a_favor")], "Subir el contrato."),
 "6": ("cumple", "listo", [("D_TITULO", "Título profesional de químico farmacéutico otorgado por la Universidad Ficticia.", "a_favor")], "Subir el título."),
 "8": ("cumple", "listo", [("D_LISTADO", "Listado de medicamentos que mantendrá el botiquín", "a_favor")], "Subir el listado."),
 "9": ("parcial", "modificar", [("D_RECEPCION", "Procedimiento de recepción de medicamentos", "a_favor")], "Agregar el procedimiento de almacenamiento de medicamentos (subapartado b) y volver a firmar."),
 "10": ("cumple", "listo", [("D_TEMP1", "lecturas diarias de enero de 2026.", "a_favor"), ("D_TEMP2", "lecturas diarias de febrero de 2026.", "a_favor")], "Subir ambos registros."),
 "11": ("cumple", "listo", [("D_VENCIDOS", "Procedimiento de eliminación de medicamentos vencidos mediante empresa autorizada.", "a_favor")], "Subir el procedimiento."),
 "12": ("no_aplica_justificado", "no_aplica", [("D_NOESTUP", "El botiquín no maneja estupefacientes ni psicotrópicos", "a_favor")], "Subir la declaración de no aplica."),
 "13": ("cumple", "listo", [("D_HORARIO", "Horario de funcionamiento del botiquín: lunes a viernes de 9 a 18 horas.", "a_favor")], "Subir el horario."),
 "14": ("cumple", "listo", [("D_DISPENSA", "Procedimiento de dispensación de medicamentos a pacientes con receta y registro.", "a_favor")], "Subir el procedimiento."),
 "16": ("cumple", "listo", [("D_CAPAC", "Programa de capacitación del personal del botiquín", "a_favor")], "Subir el programa."),
 "17": ("cumple", "listo", [("D_INVENT", "Procedimiento de control de inventario de medicamentos con conteo mensual.", "a_favor")], "Subir el procedimiento."),
 "18": ("parcial", "modificar", [("D_DECLARA", "Declaración de cumplimiento de condiciones sanitarias del local del botiquín.", "a_favor"), ("D_DECLARA", "Firma: pendiente.", "en_contra")], "Firmar la declaración y volver a subirla."),
 "19": ("cumple", "listo", [("D_AGUA", "Certificado de dotación de agua potable del local emitido por la empresa sanitaria.", "a_favor")], "Subir el certificado."),
 "20": ("cumple", "listo", [("D_RECLAMOS", "Procedimiento de manejo de reclamos de usuarios con respuesta en cinco días hábiles.", "a_favor")], "Subir el procedimiento."),
 "22": ("cumple", "listo", [("D_LIMPIEZA", "Procedimiento de limpieza del área del botiquín, diario, con registro.", "a_favor")], "Subir el procedimiento."),
}
for rid, v in E.items():
    for (aid, cita, _) in v[2]: assert cita in txt[aid], (rid, aid, cita)
FINAL = {"1": "revisar"}            # «firmada»: el código exige comprobar la firma
CODIGO = {"7": "revisar", "15": "no_encontrado", "21": "no_encontrado"}   # 7: el plano está solo en imagen; 15: el señuelo no tiene evidencia
correcto = [{"id": str(n), "presentacion": FINAL.get(str(n), E[str(n)][1]) if str(n) in E else CODIGO[str(n)]} for n in range(1, 23)]
lista_ia = [{"referencia": str(n), "texto": REQ[n] if n != 4 else "Nombramiento del químico farmacéutico responsable del botiquín.", "cita": REQ[n] if n != 4 else "Nombramiento del químico farmacéutico"} for n in range(1, 23)]
salida = {"_nota": "Encargo ficticio «organizar expediente de botiquín». Generado por pruebas/fase3e/generar-prueba-botiquin.py.",
  "carpetas": carpetas, "archivos": archivos, "norma_id": "BREQ", "resultado_correcto": correcto,
  "simulado": {"requisitos": lista_ia, "evaluaciones": {rid: {"estado": v[0], "presentacion": v[1], "evidencias": [{"cita": c, "aporta": a} for (_, c, a) in v[2]], "justificacion": f"Evaluación simulada del requisito {rid}.", "accion": v[3]} for rid, v in E.items()}}}
json.dump(salida, open("pruebas/datos-ficticios/prueba-botiquin.json", "w"), ensure_ascii=False, indent=1)
from collections import Counter
print("documentos", len([a for a in archivos if a["parents"][0] != "carpeta-botreq"]), Counter(x["presentacion"] for x in correcto))
