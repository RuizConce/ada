package cl.ada.app;

import android.content.ComponentName;
import android.content.Intent;
import android.os.Bundle;
import android.os.RemoteException;
import android.speech.RecognitionListener;
import android.speech.RecognitionService;
import android.speech.SpeechRecognizer;

/**
 * Android exige que un asistente traiga su propio reconocedor de voz. Este solo pasa el trabajo al
 * reconocedor del sistema (Google), para que el dictado de otras apps siga funcionando igual.
 */
public class ReconocimientoService extends RecognitionService {
    private SpeechRecognizer real;

    @Override
    protected void onStartListening(Intent intent, final Callback cb) {
        ComponentName cn = AdaPuente.reconocedorDelSistema(this);
        if (cn == null) { avisarError(cb, SpeechRecognizer.ERROR_CLIENT); return; }
        if (real != null) real.destroy();
        real = SpeechRecognizer.createSpeechRecognizer(this, cn);
        real.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle b) { try { cb.readyForSpeech(b); } catch (RemoteException ignorado) { } }
            @Override public void onBeginningOfSpeech() { try { cb.beginningOfSpeech(); } catch (RemoteException ignorado) { } }
            @Override public void onRmsChanged(float v) { try { cb.rmsChanged(v); } catch (RemoteException ignorado) { } }
            @Override public void onBufferReceived(byte[] b) { try { cb.bufferReceived(b); } catch (RemoteException ignorado) { } }
            @Override public void onEndOfSpeech() { try { cb.endOfSpeech(); } catch (RemoteException ignorado) { } }
            @Override public void onError(int e) { avisarError(cb, e); }
            @Override public void onResults(Bundle b) { try { cb.results(b); } catch (RemoteException ignorado) { } }
            @Override public void onPartialResults(Bundle b) { try { cb.partialResults(b); } catch (RemoteException ignorado) { } }
            @Override public void onEvent(int t, Bundle b) { }
        });
        real.startListening(intent);
    }

    private static void avisarError(Callback cb, int e) {
        try { cb.error(e); } catch (RemoteException ignorado) { }
    }

    @Override
    protected void onStopListening(Callback cb) {
        if (real != null) real.stopListening();
    }

    @Override
    protected void onCancel(Callback cb) {
        if (real != null) real.cancel();
    }

    @Override
    public void onDestroy() {
        if (real != null) real.destroy();
        real = null;
        super.onDestroy();
    }
}
