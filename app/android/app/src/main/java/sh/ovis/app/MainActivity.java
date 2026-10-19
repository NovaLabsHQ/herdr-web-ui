package sh.ovis.app;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;
import com.getcapacitor.WebViewListener;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.Collections;

/**
 * Capacitor's activity with the chosen PC as the WebView's first page, as HerdrBridgeViewController
 * does on iOS: opening or leaving a PC starts the activity again (reopen), so the next page is a
 * first load too.
 */
public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(HerdrShellPlugin.class);
        String origin = PCStore.current(this);
        String host = origin == null ? null : Uri.parse(origin).getHost();
        if (host != null) {
            boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
            // what server.url sets; the pairing link until a PC page has loaded, the origin after it
            config = new CapConfig.Builder(this)
                .setServerUrl(PCStore.pendingStart != null ? PCStore.pendingStart : origin + "/")
                // the whole PC is the app: its own links stay in the WebView, others go to the browser
                .setAllowNavigation(new String[] { host })
                .setErrorPath("error.html")
                .setWebContentsDebuggingEnabled(debuggable)
                .setLoggingEnabled(debuggable)
                .create();
        }
        super.onCreate(savedInstanceState);
        if (host != null) {
            // Capacitor injects its bridge only into the PC's origin, so error.html (served from the
            // app while a PC is open) reaches the app through this listener instead. It answers only
            // the app's own origin in the main frame: a PC page or a frame it opens gets nothing.
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                String appOrigin = bridge.getScheme() + "://" + bridge.getHost();
                WebViewCompat.addWebMessageListener(
                    bridge.getWebView(),
                    "HerdrErrorPage",
                    Collections.singleton(appOrigin),
                    (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                        if (!isMainFrame) return;
                        String asked = message.getData();
                        if ("last".equals(asked)) {
                            String last = PCStore.last(this);
                            replyProxy.postMessage(last == null ? "" : last);
                        } else if ("retry".equals(asked)) {
                            reopen();
                        } else if ("changePc".equals(asked)) {
                            PCStore.setCurrent(this, null);
                            reopen();
                        }
                    }
                );
            }
            bridge.addWebViewListener(
                new WebViewListener() {
                    @Override
                    public void onPageLoaded(WebView webView) {
                        // the PC's page is up: a pairing link has done its work
                        String url = webView.getUrl();
                        if (url != null && host.equalsIgnoreCase(Uri.parse(url).getHost())) PCStore.pendingStart = null;
                    }
                }
            );
        }
    }

    @Override
    public void onPause() {
        super.onPause();
        // WebView writes cookies to disk on its own schedule: a paired device's sign-in set a moment
        // ago would be lost if the app were swiped away now
        CookieManager.getInstance().flush();
    }

    /** Starts this activity again, so the next page (a PC, or the connect screen) is a first load. */
    void reopen() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION);
        finish();
        overridePendingTransition(0, 0);
        startActivity(intent);
    }
}
