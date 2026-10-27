package cl.ada.app;

import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognitionService;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** Lo que la página de ADA puede pedirle al teléfono (window.AdaAndroid). */
public class AdaPuente {
    private final MainActivity act;
    private final WebView web;
    private SpeechRecognizer rec;
    private int sesion = 0;
    private boolean terminada = true;

    AdaPuente(MainActivity act, WebView web) {
        this.act = act;
        this.web = web;
    }

    @JavascriptInterface
    public String version() {
        return "1";
    }

    @JavascriptInterface
    public void llamar(final String numero) {
        act.runOnUiThread(() -> act.llamar(numero));
    }

    @JavascriptInterface
    public void cambiarDireccion() {
        act.runOnUiThread(act::pedirDireccion);
    }

    @JavascriptInterface
    public void escuchar(final int id, final String idioma, final boolean parciales) {
        act.runOnUiThread(() -> iniciar(id, idioma, parciales));
    }

    @JavascriptInterface
    public void dejarDeEscuchar(final int id) {
        act.runOnUiThread(() -> {
            if (rec != null && id == sesion && !terminada) rec.stopListening();
        });
    }

    @JavascriptInterface
    public void cancelarEscucha(final int id) {
        act.runOnUiThread(() -> {
            if (rec != null && id == sesion && !terminada) {
                rec.cancel();
                terminar(id);
            }
        });
    }

    /** El reconocedor del sistema (Google), nunca el propio de ADA (que solo existe para ser asistente). */
    static ComponentName reconocedorDelSistema(Context c) {
        PackageManager pm = c.getPackageManager();
        List<ResolveInfo> lista = pm.queryIntentServices(new Intent(RecognitionService.SERVICE_INTERFACE), 0);
        ComponentName otro = null;
        for (ResolveInfo r : lista) {
            if (r.serviceInfo == null || c.getPackageName().equals(r.serviceInfo.packageName)) continue;
            ComponentName cn = new ComponentName(r.serviceInfo.packageName, r.serviceInfo.name);
            if (r.serviceInfo.packageName.startsWith("com.google")) return cn;
            if (otro == null) otro = cn;
        }
        return otro;
    }

    private void iniciar(int id, String idioma, boolean parciales) {
        if (!act.tiene(Manifest.permission.RECORD_AUDIO)) {
            emitir(id, "error", "not-allowed");
            emitir(id, "fin", null);
            act.requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 15);
            return;
        }
        if (rec != null) {
            try { rec.cancel(); } catch (Exception ignorado) { }
            if (!terminada) terminar(sesion);
        }
        if (rec == null) {
            ComponentName cn = reconocedorDelSistema(act);
            rec = cn != null ? SpeechRecognizer.createSpeechRecognizer(act, cn) : SpeechRecognizer.createSpeechRecognizer(act);
        }
        sesion = id;
        terminada = false;
        final int miSesion = id;
        rec.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle b) { if (miSesion == sesion) emitir(miSesion, "inicio", null); }
            @Override public void onBeginningOfSpeech() { }
            @Override public void onRmsChanged(float v) { }
            @Override public void onBufferReceived(byte[] b) { }
            @Override public void onEndOfSpeech() { }
            @Override public void onEvent(int t, Bundle b) { }

            @Override
            public void onPartialResults(Bundle b) {
                String t = texto(b);
                if (miSesion == sesion && !terminada && t != null && !t.isEmpty()) emitir(miSesion, "parcial", t);
            }

            @Override
            public void onResults(Bundle b) {
                if (miSesion != sesion || terminada) return;
                String t = texto(b);
                if (t != null && !t.isEmpty()) emitir(miSesion, "final", t);
                terminar(miSesion);
            }

            @Override
            public void onError(int e) {
                if (miSesion != sesion || terminada) return;
                emitir(miSesion, "error", nombreError(e));
                terminar(miSesion);
            }
        });
        Intent it = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        it.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        it.putExtra(RecognizerIntent.EXTRA_LANGUAGE, idioma == null ? "es-CL" : idioma);
        it.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, parciales);
        it.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        it.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, act.getPackageName());
        it.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 1500L);
        it.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1200L);
        try {
            rec.startListening(it);
        } catch (Exception e) {
            emitir(id, "error", "audio-capture");
            terminar(id);
        }
    }

    private void terminar(int id) {
        if (id == sesion) terminada = true;
        emitir(id, "fin", null);
    }

    private static String texto(Bundle b) {
        if (b == null) return null;
        ArrayList<String> l = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return l == null || l.isEmpty() ? null : l.get(0);
    }

    private static String nombreError(int e) {
        switch (e) {
            case SpeechRecognizer.ERROR_NO_MATCH:
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
                return "no-speech";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                return "not-allowed";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                return "network";
            case SpeechRecognizer.ERROR_AUDIO:
                return "audio-capture";
            default:
                return "aborted";
        }
    }

    private void emitir(int id, String tipo, String dato) {
        final String js = "window.__adaVoz&&window.__adaVoz(" + id + ",'" + tipo + "'," + (dato == null ? "null" : JSONObject.quote(dato)) + ")";
        web.post(() -> web.evaluateJavascript(js, null));
    }

    void liberar() {
        if (rec != null) {
            try { rec.destroy(); } catch (Exception ignorado) { }
            rec = null;
        }
    }
}
