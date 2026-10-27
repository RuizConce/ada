package cl.ada.app;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.service.voice.VoiceInteractionSession;

/** Al mantener presionado el botón de encendido (o el gesto del asistente), abre ADA escuchando. */
public class AsistenteSession extends VoiceInteractionSession {
    AsistenteSession(Context c) {
        super(c);
    }

    @Override
    public void onShow(Bundle args, int flags) {
        super.onShow(args, flags);
        Intent i = new Intent(getContext(), MainActivity.class)
            .setAction(MainActivity.ACCION_ESCUCHAR)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        try {
            if (Build.VERSION.SDK_INT >= 29) startAssistantActivity(i);
            else getContext().startActivity(i);
        } catch (Exception e) {
            getContext().startActivity(i);
        }
        hide();
    }
}
