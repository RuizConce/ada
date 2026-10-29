# Genera pruebas/datos-ficticios/prueba-i.json: pauta ficticia con 20 requisitos (+3 artículos que no son
# requisitos) y 15 documentos ficticios de un centro ficticio, con resultado correcto conocido.
# Comprueba que cada cita guionada existe tal cual en su documento.
import json, os
R = [
 ("Art. 1","La recepción debe exhibir en un lugar visible el horario de atención del centro."),
 ("Art. 2","La sala de espera debe contar con al menos 8 asientos."),
 ("Art. 3","Debe existir un baño accesible para personas con movilidad reducida en cada piso del centro."),
 ("Art. 4","Debe haber un extintor de polvo químico seco con carga vigente en cada piso del centro."),
 ("Art. 5","El centro debe contar con un plan de emergencia aprobado por la dirección."),
 ("Art. 6","Debe realizarse un simulacro de evacuación al menos una vez al año."),
 ("Art. 7","Todos los profesionales de salud deben tener inscripción vigente en el registro nacional de prestadores."),
 ("Art. 8","Todo el personal clínico debe completar cada año una capacitación en prevención de infecciones."),
 ("Art. 9","Si el centro toma muestras de laboratorio, debe tener un contrato vigente con un laboratorio autorizado."),
 ("Art. 10","Debe llevarse un registro de mantención preventiva de los equipos médicos."),
 ("Art. 11","Si el centro cuenta con un equipo de rayos X, debe tener autorización vigente de la instalación radiológica."),
 ("Art. 12","Cada box de atención debe contar con un contenedor rígido para material cortopunzante."),
 ("Art. 13","La ficha clínica debe ser electrónica y contar con respaldo diario."),
 ("Art. 14","Debe existir un procedimiento escrito para recibir y responder reclamos de los pacientes."),
 ("Art. 15","Las vías de evacuación deben contar con señalización iluminada."),
 ("Art. 16","Si se atiende a menores de edad, debe existir una sala de espera diferenciada para ellos."),
 ("Art. 17","Debe realizarse un control de plagas al menos cada seis meses."),
 ("Art. 18","La dirección técnica debe estar a cargo de un profesional con jornada de al menos 22 horas semanales."),
 ("Art. 19","Debe mantenerse un inventario actualizado de los medicamentos del centro."),
 ("Art. 20","El centro debe contar con un generador eléctrico de respaldo con mantención anual."),
]
norma = ["PAUTA FICTICIA DE CENTROS AMBULATORIOS (PRUEBA I)", "Documento de prueba. No corresponde a ninguna norma real.", "Página 1",
 "Título I. Objeto", "Esta pauta fija las condiciones mínimas de funcionamiento de los centros ambulatorios ficticios usados en las pruebas de ADA.",
 "Título II. Requisitos"]
for i,(ref,t) in enumerate(R,1):
    if i in (8,15): norma += [f"Página {2 if i==8 else 3}"]
    norma.append(f"Artículo {i}. {t}")
norma += ["Título III. Disposiciones finales", "Artículo 21. La autoridad sanitaria ficticia podrá fiscalizar estas condiciones.",
 "Artículo 22. Las infracciones se sancionarán conforme a la normativa general.", "Artículo 23. Esta pauta rige desde su publicación."]

RELLENO = [
 "El centro funciona en un edificio de dos pisos ubicado en una calle ficticia de la ciudad.",
 "La administración informa que durante el año se renovaron las cortinas y se pintaron los pasillos.",
 "Se deja constancia de que el estacionamiento es compartido con un local comercial vecino.",
 "La red de internet fue reemplazada por una de mayor velocidad en el mes de abril.",
 "El personal administrativo participa en reuniones de coordinación semanales.",
]
def doc(titulo, paginas):
    l=[titulo, "Documento ficticio para pruebas."]
    for n,(secciones) in enumerate(paginas,1):
        l.append(f"Página {n}")
        for s in secciones: l.append(s)
    return "\n".join(l)
D = {
 "ID01": ("Informe de recepción y sala de espera (ficticio).pdf", [["Recepción", "La recepción exhibe en un lugar visible el horario de atención del centro, de lunes a viernes de 8:00 a 20:00 horas.", RELLENO[0]], ["Sala de espera", "La sala de espera dispone de 5 asientos en buen estado.", RELLENO[1]]]),
 "ID02": ("Informe de infraestructura del primer piso (ficticio).pdf", [["Accesibilidad", "En el primer piso existe un baño accesible para personas con movilidad reducida, con barras de apoyo.", "En el segundo piso no existe baño accesible para personas con movilidad reducida.", RELLENO[2]], ["Seguridad", "En el primer piso hay un extintor de polvo químico seco con carga vigente hasta abril de 2027.", RELLENO[3]]]),
 "ID03": ("Certificado de mantención de extintores (ficticio).pdf", [["Certificado", "Se certifica la mantención del extintor de polvo químico seco del segundo piso, con carga vigente hasta julio de 2027.", "La empresa mantenedora es ficticia y está inscrita en un registro ficticio."]]),
 "ID04": ("Plan de emergencia y simulacros (ficticio).pdf", [["Plan de emergencia", "El plan de emergencia del centro fue aprobado por la dirección en marzo de 2026.", "El plan considera la ubicación de extintores y los puntos de encuentro."], ["Simulacros", "Se realizó un simulacro de evacuación en mayo de 2026, con participación de todo el personal.", RELLENO[4]]]),
 "ID05": ("Acta del comité de calidad (ficticia).pdf", [["Asistentes", "Asisten la directora técnica, la enfermera coordinadora y el encargado de mantención."], ["Acuerdos", "Se informa que el plan de emergencia aún no ha sido aprobado por la dirección y se encuentra en revisión.", "Se informa además que la autorización de la instalación radiológica de rayos X venció en junio de 2026.", "Se acuerda revisar el tema en la próxima sesión."]]),
 "ID06": ("Nómina del personal y dirección técnica (ficticia).pdf", [["Profesionales de salud", "Los profesionales de salud del centro son cuatro: la Dra. Paula Vera, el Dr. Tomás Ruiz, la enfermera Inés Lagos y el kinesiólogo Raúl Díaz.", "Inscripción en el registro nacional de prestadores: Dra. Paula Vera vigente, Dr. Tomás Ruiz vigente e Inés Lagos vigente."], ["Dirección técnica", "La dirección técnica está a cargo de la Dra. Paula Vera, con una jornada de 44 horas semanales.", RELLENO[0]]]),
 "ID07": ("Certificado de registro de prestador (ficticio).pdf", [["Certificado", "Se certifica que el kinesiólogo Raúl Díaz tiene inscripción vigente en el registro nacional de prestadores.", "Este certificado es ficticio y se emitió para pruebas."]]),
 "ID08": ("Registro de capacitaciones (ficticio).pdf", [["Prevención de infecciones", "El personal clínico está compuesto por cinco personas.", "Durante 2026, tres de las cinco personas del personal clínico completaron la capacitación anual en prevención de infecciones; las otras dos aún no la realizan.", RELLENO[1]], ["Otras capacitaciones", "Todo el personal asistió a una charla sobre buen trato al paciente."]]),
 "ID09": ("Informe de farmacia y laboratorio (ficticio).pdf", [["Laboratorio", "El centro no toma muestras de laboratorio; los pacientes que las requieren son derivados a un laboratorio externo.", RELLENO[2]], ["Medicamentos", "El inventario de medicamentos se encuentra actualizado al 30 de septiembre de 2026, con firma de la química farmacéutica."]]),
 "ID10": ("Registro de mantención de equipos (ficticio).pdf", [["Equipos médicos", "Se lleva un registro de mantención preventiva de los equipos médicos, con fecha, responsable y próxima revisión de cada equipo.", RELLENO[3]], ["Observaciones", "Los equipos de climatización recibieron mantención en enero de 2026."]]),
 "ID11": ("Informe del equipo de rayos X (ficticio).pdf", [["Equipo", "El centro cuenta con un equipo de rayos X dental en el box 3."], ["Autorización", "La instalación radiológica del equipo de rayos X cuenta con autorización vigente hasta agosto de 2028.", RELLENO[4]]]),
 "ID12": ("Informe de inspección de boxes y plagas (ficticio).pdf", [["Boxes de atención", "Ninguno de los boxes de atención cuenta con contenedor rígido para material cortopunzante; se usan botellas plásticas.", RELLENO[0]], ["Control de plagas", "El último control de plagas se realizó en diciembre de 2024."]]),
 "ID13": ("Informe de sistemas de información (ficticio).pdf", [["Ficha clínica", "La ficha clínica del centro es electrónica desde 2024.", "El respaldo de la ficha clínica electrónica se realiza una vez por semana, los días viernes.", RELLENO[3]]]),
 "ID14": ("Procedimiento de reclamos (ficticio).pdf", [["Procedimiento", "Existe un procedimiento escrito para recibir y responder reclamos de los pacientes, con un plazo de respuesta de diez días hábiles.", "Los reclamos se registran en un libro foliado ficticio."]]),
 "ID15": ("Reglamento interno de admisión (ficticio).pdf", [["Pacientes", "El centro atiende exclusivamente a pacientes adultos; no se atiende a menores de edad.", RELLENO[1]], ["Horario", "El reglamento repite el horario de atención para conocimiento del personal."]]),
}
E = {  # resultado correcto y respuesta guionada del Claude simulado (citas textuales de los documentos)
 "R1": ("cumple", [("ID01","La recepción exhibe en un lugar visible el horario de atención del centro","a_favor")]),
 "R2": ("no_cumple", [("ID01","La sala de espera dispone de 5 asientos","en_contra")]),
 "R3": ("parcial", [("ID02","En el primer piso existe un baño accesible para personas con movilidad reducida","a_favor"),("ID02","En el segundo piso no existe baño accesible para personas con movilidad reducida","en_contra")]),
 "R4": ("cumple", [("ID02","En el primer piso hay un extintor de polvo químico seco con carga vigente hasta abril de 2027","a_favor"),("ID03","extintor de polvo químico seco del segundo piso, con carga vigente hasta julio de 2027","a_favor")]),
 "R5": ("contradictorio", [("ID04","El plan de emergencia del centro fue aprobado por la dirección en marzo de 2026","a_favor"),("ID05","el plan de emergencia aún no ha sido aprobado por la dirección","en_contra")]),
 "R6": ("cumple", [("ID04","Se realizó un simulacro de evacuación en mayo de 2026","a_favor")]),
 "R7": ("cumple", [("ID06","Los profesionales de salud del centro son cuatro","a_favor"),("ID06","Dra. Paula Vera vigente, Dr. Tomás Ruiz vigente e Inés Lagos vigente","a_favor"),("ID07","el kinesiólogo Raúl Díaz tiene inscripción vigente en el registro nacional de prestadores","a_favor")]),
 "R8": ("parcial", [("ID08","tres de las cinco personas del personal clínico completaron la capacitación anual en prevención de infecciones","a_favor"),("ID08","las otras dos aún no la realizan","en_contra")]),
 "R9": ("no_aplica_justificado", [("ID09","El centro no toma muestras de laboratorio","a_favor")]),
 "R10": ("cumple", [("ID10","Se lleva un registro de mantención preventiva de los equipos médicos","a_favor")]),
 "R11": ("contradictorio", [("ID11","La instalación radiológica del equipo de rayos X cuenta con autorización vigente hasta agosto de 2028","a_favor"),("ID05","la autorización de la instalación radiológica de rayos X venció en junio de 2026","en_contra")]),
 "R12": ("no_cumple", [("ID12","Ninguno de los boxes de atención cuenta con contenedor rígido para material cortopunzante","en_contra")]),
 "R13": ("parcial", [("ID13","La ficha clínica del centro es electrónica desde 2024","a_favor"),("ID13","El respaldo de la ficha clínica electrónica se realiza una vez por semana","en_contra")]),
 "R14": ("cumple", [("ID14","Existe un procedimiento escrito para recibir y responder reclamos de los pacientes","a_favor")]),
 "R15": ("sin_evidencia", []),
 "R16": ("no_aplica_justificado", [("ID15","El centro atiende exclusivamente a pacientes adultos; no se atiende a menores de edad","a_favor")]),
 "R17": ("no_cumple", [("ID12","El último control de plagas se realizó en diciembre de 2024","en_contra")]),
 "R18": ("cumple", [("ID06","La dirección técnica está a cargo de la Dra. Paula Vera, con una jornada de 44 horas semanales","a_favor")]),
 "R19": ("cumple", [("ID09","El inventario de medicamentos se encuentra actualizado al 30 de septiembre de 2026","a_favor")]),
 "R20": ("sin_evidencia", []),
}
docs = [{"id": k, "nombre": v[0], "texto": doc(v[0].replace(" (ficticio).pdf","").replace(" (ficticia).pdf","").upper(), v[1])} for k,v in D.items()]
txt = {d["id"]: d["texto"] for d in docs}
for rid,(est,evs) in E.items():
    for (did,cita,_) in evs: assert cita in txt[did], (rid, did, cita)
normatxt = "\n".join(norma)
for ref,t in R: assert t in normatxt
salida = {
 "_nota": "Prueba I (Fase 3e): pauta ficticia con 20 requisitos (+3 artículos que no son requisitos) y 15 documentos ficticios de un centro ficticio. Todo es inventado. Generado por pruebas/fase3e/generar-prueba-i.py, que comprueba que cada cita existe tal cual. 'simulado' son las respuestas del Claude simulado (prueban el mecanismo, no la precisión real).",
 "norma": {"nombre": "Pauta ficticia de centros ambulatorios (prueba I).pdf", "texto": normatxt},
 "documentos": docs,
 "requisitos_esperados": [{"id": f"R{i}", "referencia": ref, "texto": t} for i,(ref,t) in enumerate(R,1)],
 "resultado_correcto": [{"id": rid, "estado": est, "archivos": sorted(set(e[0] for e in evs))} for rid,(est,evs) in E.items()],
 "simulado": {
   "requisitos": [{"referencia": ref, "texto": t, "cita": t} for ref,t in R] + [{"referencia": "Art. 4 (repetido)", "texto": R[3][1], "cita": R[3][1]}, {"referencia": "Art. 50", "texto": "El centro debe tener helipuerto.", "cita": "El centro debe contar con un helipuerto en la azotea."}],
   "evaluaciones": {rid: {"estado": est, "evidencias": [{"cita": c, "aporta": a} for (_,c,a) in evs], "justificacion": f"Evaluación simulada de {rid}: estado {est} según los documentos citados."} for rid,(est,evs) in E.items()},
 },
}
os.makedirs("pruebas/datos-ficticios", exist_ok=True)
json.dump(salida, open("pruebas/datos-ficticios/prueba-i.json","w"), ensure_ascii=False, indent=1)
print("documentos", len(docs), "caracteres", sum(len(d["texto"]) for d in docs), "norma", len(normatxt))
from collections import Counter; print(Counter(e[0] for e in E.values()))
