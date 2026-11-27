package com.smoa;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.redirectedUrl;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.context.TestPropertySource;

import com.smoa.support.ApiTestBase;

@TestPropertySource(properties = {"smoa.security.protect-app-shell=true", "smoa.otp.required=false"})
class ProtectedShellWithoutOtpTest extends ApiTestBase {

    @Test
    void 보호된_앱은_OTP_없이_로그인할_수_있고_비로그인_접근은_차단된다() throws Exception {
        var browser = client();
        browser.get("/api/auth/otp-policy").andExpect(status().isOk())
                .andExpect(jsonPath("$.required").value(false));
        browser.perform(get("/index.html").accept(MediaType.TEXT_HTML))
                .andExpect(redirectedUrl("/login.html"))
                .andExpect(header().string("X-Robots-Tag", "noindex, nofollow"));
        browser.get("/api/programs/people/page").andExpect(status().isUnauthorized());

        var admin = createSuperAdmin();
        browser.login(admin.username(), PASSWORD).andExpect(status().isOk());
        browser.get("/index.html").andExpect(status().isOk());
    }
}
