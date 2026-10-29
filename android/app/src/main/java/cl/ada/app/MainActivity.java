package cl.ada.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;

/**
 * ADA para Android: la misma ADA web (Railway) dentro de la app, más lo que solo una app nativa puede hacer:
 * llamar directo, escuchar con el reconocimiento de voz de Android y abrirse como asistente del teléfono.
 */
public class MainActivity extends Activity {
    static final String ACCION_ESCUCHAR = "cl.ada.app.ESCUCHAR";
    static final String ACCION_REUNION = "cl.ada.app.REUNION";
    private static final int REQ_PERMISOS = 11;
    private static final int REQ_MIC_WEB = 12;
    private static final int REQ_ARCHIVO = 13;
    private static final int REQ_LLAMAR = 14;

    private WebView web;
    private AdaPuente puente;
    private PermissionRequest pedidoMicWeb;
    private ValueCallback<Uri[]> eligiendoArchivo;
    private String llamadaPendiente;
    private boolean paginaCargada = false;

    @Override
    protected void onCreate(Bundle estado) {
        super.onCreate(estado);
        web = new WebView(this);
        web.setBackgroundColor(0xFF0A0F14);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString() + " AdaAndroid/1");
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        puente = new AdaPuente(this, web);
        web.addJavascriptInterface(puente, "AdaAndroid");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                String base = direccion();
                String hostAda = base == null ? null : Uri.parse(base).getHost();
                String esquema = u.getScheme() == null ? "" : u.getScheme();
                if ((esquema.equals("https") || esquema.equals("http")) && hostAda != null && hostAda.equalsIgnoreCase(u.getHost())) {
                    return false; // se queda dentro de ADA
                }
                // tel:, mailto:, WhatsApp, Google, enlaces externos: con la app que corresponda.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (ActivityNotFoundException e) {
                    Toast.makeText(MainActivity.this, "No hay una app para abrir esto", Toast.LENGTH_SHORT).show();
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                paginaCargada = true;
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) {
                    paginaCargada = false;
                    new AlertDialog.Builder(MainActivity.this)
                        .setTitle("No pude abrir ADA")
                        .setMessage("Revisa tu conexión a internet. Si cambió la dirección de ADA, puedes corregirla.")
                        .setPositiveButton("Reintentar", (d, w) -> cargar(false))
                        .setNegativeButton("Cambiar dirección", (d, w) -> pedirDireccion())
                        .show();
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest pedido) {
                runOnUiThread(() -> {
                    if (tiene(Manifest.permission.RECORD_AUDIO)) {
                        pedido.grant(pedido.getResources());
                    } else {
                        pedidoMicWeb = pedido;
                        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC_WEB);
                    }
                });
            }

            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (eligiendoArchivo != null) eligiendoArchivo.onReceiveValue(null);
                eligiendoArchivo = cb;
                try {
                    startActivityForResult(p.createIntent(), REQ_ARCHIVO);
                } catch (ActivityNotFoundException e) {
                    eligiendoArchivo = null;
                    return false;
                }
                return true;
            }
        });

        // Descargas (Word, Excel, documentos): ADA entrega un enlace temporal; el gestor de descargas de Android
        // lo guarda en Descargas y muestra la notificación. Si no se puede, se abre con el navegador.
        web.setDownloadListener((url, ua, cd, mime, largo) -> descargar(url, ua, cd, mime));

        pedirPermisosIniciales();
        Intent inicio = getIntent();
        if (inicio != null && ACCION_REUNION.equals(inicio.getAction())) cargar("/reunion.html");
        else cargar(pideEscuchar(inicio));
    }

    // ---------- Descargas ----------

    void descargar(String url, String ua, String cd, String mime) {
        if (url == null || url.startsWith("blob:") || url.startsWith("data:")) {
            Toast.makeText(this, "No pude guardar el archivo. Actualiza ADA (cierra y vuelve a abrir) e inténtalo de nuevo.", Toast.LENGTH_LONG).show();
            return;
        }
        try {
            String nombre = android.webkit.URLUtil.guessFileName(url, cd, mime);
            android.app.DownloadManager.Request pedido = new android.app.DownloadManager.Request(Uri.parse(url));
            if (mime != null && !mime.isEmpty()) pedido.setMimeType(mime);
            if (ua != null) pedido.addRequestHeader("User-Agent", ua);
            pedido.setTitle(nombre);
            pedido.setDescription("Descargado desde ADA");
            pedido.setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            pedido.setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, nombre);
            android.app.DownloadManager dm = (android.app.DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            dm.enqueue(pedido);
            Toast.makeText(this, "Descargando " + nombre + " en Descargas…", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            } catch (Exception ignorado) {
                Toast.makeText(this, "No pude descargar el archivo", Toast.LENGTH_LONG).show();
            }
        }
    }

    // ---------- Dirección de ADA ----------

    String direccion() {
        SharedPreferences p = getSharedPreferences("ada", MODE_PRIVATE);
        String guardada = p.getString("url", null);
        if (guardada != null && !guardada.isEmpty()) return guardada;
        String fija = getString(R.string.ada_url);
        return fija.isEmpty() ? null : fija;
    }

    void pedirDireccion() {
        final EditText campo = new EditText(this);
        campo.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        campo.setHint("ada-produccion.up.railway.app");
        String actual = direccion();
        if (actual != null) campo.setText(actual.replaceFirst("^https?://", ""));
        new AlertDialog.Builder(this)
            .setTitle("Dirección de ADA")
            .setMessage("Es la dirección web que aparece arriba en Chrome cuando abres ADA, por ejemplo: algo.up.railway.app. (Tu nombre y clave se piden después.)")
            .setView(campo)
            .setCancelable(false)
            .setPositiveButton("Guardar", (d, w) -> {
                String t = campo.getText().toString().trim().replaceAll("\\s+", "").replaceAll("/+$", "");
                // Tiene que ser una dirección web (con punto), no un nombre.
                if (t.isEmpty() || !t.contains(".")) {
                    Toast.makeText(MainActivity.this, "Escribe la dirección web de ADA (termina en .up.railway.app), no tu nombre.", Toast.LENGTH_LONG).show();
                    pedirDireccion();
                    return;
                }
                if (!t.startsWith("http")) t = "https://" + t;
                getSharedPreferences("ada", MODE_PRIVATE).edit().putString("url", t).apply();
                cargar(false);
            })
            .show();
    }

    private void cargar(boolean escuchar) {
        cargar(escuchar ? "/?escuchar=1" : "/");
    }

    private void cargar(String ruta) {
        String base = direccion();
        if (base == null) { pedirDireccion(); return; }
        paginaCargada = false;
        web.loadUrl(base + ruta);
    }

    // ---------- Abrir escuchando (asistente, mosaico, acceso directo) ----------

    static boolean pideEscuchar(Intent i) {
        if (i == null || i.getAction() == null) return false;
        String a = i.getAction();
        return a.equals(ACCION_ESCUCHAR) || a.equals(Intent.ACTION_ASSIST) || a.equals(Intent.ACTION_VOICE_COMMAND);
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        setIntent(i);
        if (i != null && ACCION_REUNION.equals(i.getAction())) { cargar("/reunion.html"); return; }
        if (pideEscuchar(i)) {
            if (paginaCargada) web.evaluateJavascript("window.adaEscuchar && window.adaEscuchar()", null);
            else cargar(true);
        }
    }

    // ---------- Llamar directo ----------

    void llamar(String numero) {
        String n = numero.replaceAll("[^0-9+]", "");
        if (!n.startsWith("+")) n = "+" + n;
        Uri u = Uri.parse("tel:" + n);
        if (tiene(Manifest.permission.CALL_PHONE)) {
            try {
                startActivity(new Intent(Intent.ACTION_CALL, u));
                return;
            } catch (Exception ignorado) { }
        } else {
            llamadaPendiente = n;
            requestPermissions(new String[]{Manifest.permission.CALL_PHONE}, REQ_LLAMAR);
            return;
        }
        startActivity(new Intent(Intent.ACTION_DIAL, u));
    }

    // ---------- Permisos ----------

    boolean tiene(String permiso) {
        return checkSelfPermission(permiso) == PackageManager.PERMISSION_GRANTED;
    }

    private void pedirPermisosIniciales() {
        List<String> faltan = new ArrayList<>();
        if (!tiene(Manifest.permission.RECORD_AUDIO)) faltan.add(Manifest.permission.RECORD_AUDIO);
        if (!tiene(Manifest.permission.CALL_PHONE)) faltan.add(Manifest.permission.CALL_PHONE);
        if (Build.VERSION.SDK_INT >= 33 && !tiene(Manifest.permission.POST_NOTIFICATIONS)) faltan.add(Manifest.permission.POST_NOTIFICATIONS);
        if (!faltan.isEmpty()) requestPermissions(faltan.toArray(new String[0]), REQ_PERMISOS);
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] permisos, int[] resultados) {
        super.onRequestPermissionsResult(req, permisos, resultados);
        boolean ok = resultados.length > 0 && resultados[0] == PackageManager.PERMISSION_GRANTED;
        if (req == REQ_MIC_WEB && pedidoMicWeb != null) {
            if (ok) pedidoMicWeb.grant(pedidoMicWeb.getResources()); else pedidoMicWeb.deny();
            pedidoMicWeb = null;
        } else if (req == REQ_LLAMAR && llamadaPendiente != null) {
            String n = llamadaPendiente;
            llamadaPendiente = null;
            Uri u = Uri.parse("tel:" + n);
            try {
                startActivity(new Intent(ok ? Intent.ACTION_CALL : Intent.ACTION_DIAL, u));
            } catch (Exception e) {
                startActivity(new Intent(Intent.ACTION_DIAL, u));
            }
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent datos) {
        super.onActivityResult(req, res, datos);
        if (req == REQ_ARCHIVO && eligiendoArchivo != null) {
            eligiendoArchivo.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, datos));
            eligiendoArchivo = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    // Pantalla apagada o app en segundo plano: la página queda "oculta" y deja de escuchar.
    @Override
    protected void onPause() {
        super.onPause();
        if (web != null) {
            web.evaluateJavascript("window.__adaOido && window.__adaOido.cerrar()", null);
            web.onPause();
        }
        if (puente != null) puente.liberar();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onDestroy() {
        if (puente != null) puente.liberar();
        super.onDestroy();
    }
}
