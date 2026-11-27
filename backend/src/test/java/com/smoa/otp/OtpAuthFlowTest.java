package com.smoa.otp;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextImpl;
import org.springframework.security.web.context.HttpSessionSecurityContextRepository;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.ResultActions;

import com.smoa.account.Account;
import com.smoa.security.SmoaUserDetails;
import com.smoa.support.ApiTestBase;
import com.smoa.support.TestClient;

class OtpAuthFlowTest extends ApiTestBase {

    @TempDir
    static Path stateDirectory;

    @Autowired
    OtpService otp;

    @DynamicPropertySource
    static void otpProperties(DynamicPropertyRegistry properties) throws IOException {
        Path key = stateDirectory.resolve("key");
        byte[] secret = new byte[32];
        new SecureRandom().nextBytes(secret);
        Files.write(key, secret);
        properties.add("smoa.otp.required", () -> true);
        properties.add("smoa.otp.key-file", () -> key.toString());
        properties.add("smoa.otp.state-file", () -> stateDirectory.resolve("state").toString());
    }

    @Test
    void 앱_진입은_OTP_세션이_필요하고_로그인과_정책만_공개된다() throws Exception {
        client().get("/api/auth/otp-policy").andExpect(status().isOk())
                .andExpect(jsonPath("$.required").value(true))
                .andExpect(header().string("X-Robots-Tag", "noindex, nofollow"));
        client().get("/login.html").andExpect(status().isOk());
        client().get("/index.html").andExpect(status().isUnauthorized());
        client().perform(get("/").accept(MediaType.TEXT_HTML)).andExpect(status().is3xxRedirection())
                .andExpect(header().string(HttpHeaders.LOCATION, "/login.html"));

        Account account = createSuperAdmin();
        TestClient client = client();
        login(client, account, PASSWORD, currentCode(otp.provision(account.id()))).andExpect(status().isOk());
        client.get("/index.html").andExpect(status().isOk());
    }

    @Test
    void 비밀번호_다음에만_OTP를_확인하고_재사용과_이전_세션을_차단한다() throws Exception {
        Account account = createAccount(createPackage("OTP 사용자", Map.of(), org()));
        login(client(), account, PASSWORD, "123456").andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("OTP_NOT_ENROLLED"));
        login(client(), account, PASSWORD, null).andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("OTP_REQUIRED"));
        login(client(), account, PASSWORD, "not-digits").andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("OTP_INVALID"));

        String code = currentCode(otp.provision(account.id()));
        login(client(), account, "Wrong-" + PASSWORD, code).andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("LOGIN_FAILED"));
        TestClient loggedIn = client();
        login(loggedIn, account, PASSWORD, code).andExpect(status().isOk());
        loggedIn.get("/api/auth/me").andExpect(status().isOk());
        login(client(), account, PASSWORD, code).andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("OTP_INVALID"));

        var oldPrincipal = new SmoaUserDetails(account.id(), account.username(), null,
                account.credentialVersion());
        var oldAuthentication = UsernamePasswordAuthenticationToken.authenticated(oldPrincipal, null,
                oldPrincipal.getAuthorities());
        var oldSession = new MockHttpSession();
        oldSession.setAttribute(HttpSessionSecurityContextRepository.SPRING_SECURITY_CONTEXT_KEY,
                new SecurityContextImpl(oldAuthentication));
        mvc.perform(get("/api/auth/me").session(oldSession)).andExpect(status().isUnauthorized());
        assertThat(oldSession.isInvalid()).isTrue();
    }

    @Test
    void 관리자만_다른_계정의_등록_키를_받고_확인된_키는_다시_받지_못한다() throws Exception {
        Account admin = createSuperAdmin();
        TestClient adminClient = client();
        login(adminClient, admin, PASSWORD, currentCode(otp.provision(admin.id()))).andExpect(status().isOk());
        adminClient.refreshCsrf();
        Account user = createAccount(createPackage("OTP 수신자", Map.of(), org()));
        String endpoint = "/api/admin/accounts/" + user.id() + "/otp";

        adminClient.postWithoutCsrf(endpoint, null).andExpect(status().isForbidden());
        adminClient.post("/api/admin/accounts/" + admin.id() + "/otp", null).andExpect(status().isForbidden());
        var enrollment = adminClient.post(endpoint, null).andExpect(status().isOk())
                .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"));
        String secret = adminClient.json(enrollment).path("secret").asText();
        assertThat(secret).matches("[A-Z2-7]{32}");
        adminClient.get("/api/admin/accounts/" + user.id()).andExpect(status().isOk())
                .andExpect(jsonPath("$.otpEnrolled").value(false))
                .andExpect(jsonPath("$.secret").doesNotExist());

        TestClient userClient = client();
        login(userClient, user, PASSWORD, currentCode(secret)).andExpect(status().isOk());
        userClient.refreshCsrf();
        userClient.post(endpoint, null).andExpect(status().isForbidden());
        adminClient.get("/api/admin/accounts/" + user.id()).andExpect(status().isOk())
                .andExpect(jsonPath("$.otpEnrolled").value(true))
                .andExpect(jsonPath("$.secret").doesNotExist());
        adminClient.post(endpoint, null).andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("OTP_ALREADY_ENROLLED"));
    }

    private static ResultActions login(TestClient client, Account account, String password, String code)
            throws Exception {
        var request = post("/api/auth/login").contentType(MediaType.APPLICATION_FORM_URLENCODED)
                .param("username", account.username()).param("password", password)
                .header(TestClient.CSRF_HEADER, client.refreshCsrf());
        if (code != null) {
            request.param("otp", code);
        }
        return client.perform(request);
    }

    private static String currentCode(String secret) {
        return Totp.code(Totp.decode(secret), Instant.now().getEpochSecond() / Totp.PERIOD_SECONDS, 6);
    }
}
