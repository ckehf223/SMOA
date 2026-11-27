package com.smoa.support;

import java.util.concurrent.atomic.AtomicInteger;

import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import jakarta.servlet.http.HttpSession;

/**
 * 브라우저 한 대를 흉내 낸다: 세션(쿠키)과 현재 CSRF 토큰을 유지한다. 클라이언트마다 다른 원격 IP 를 써서
 * 로그인 제한(IP 단위)이 테스트끼리 섞이지 않게 한다. 실제 로그인 필터·세션·CSRF 필터를 그대로 통과한다.
 */
public final class TestClient {

    public static final String CSRF_HEADER = "X-CSRF-TOKEN";
    private static final AtomicInteger SEQUENCE = new AtomicInteger();
    private static final ObjectMapper JSON = new ObjectMapper();

    private final MockMvc mvc;
    private final String remoteIp;
    private MockHttpSession session;
    private String csrfToken;

    public TestClient(MockMvc mvc) {
        this.mvc = mvc;
        int n = SEQUENCE.incrementAndGet();
        this.remoteIp = "10." + (n / 62500 % 250) + "." + (n / 250 % 250) + "." + (n % 250 + 1);
    }

    public ResultActions perform(MockHttpServletRequestBuilder builder) throws Exception {
        builder.with(request -> {
            request.setRemoteAddr(remoteIp);
            return request;
        });
        if (session != null) {
            builder.session(session);
        }
        ResultActions result = mvc.perform(builder);
        HttpSession current = result.andReturn().getRequest().getSession(false);
        session = current instanceof MockHttpSession mock ? mock : null;
        return result;
    }

    public String sessionId() {
        return session == null ? null : session.getId();
    }

    public String csrf() {
        return csrfToken;
    }

    /** GET /api/auth/csrf 로 현재 세션의 토큰을 받아 보관한다. */
    public String refreshCsrf() throws Exception {
        String body = perform(MockMvcRequestBuilders.get("/api/auth/csrf")).andReturn().getResponse()
                .getContentAsString();
        csrfToken = JSON.readTree(body).get("token").asText();
        return csrfToken;
    }

    public ResultActions get(String url) throws Exception {
        return perform(MockMvcRequestBuilders.get(url));
    }

    public ResultActions post(String url, Object body) throws Exception {
        return send(MockMvcRequestBuilders.post(url), body, true);
    }

    public ResultActions postWithoutCsrf(String url, Object body) throws Exception {
        return send(MockMvcRequestBuilders.post(url), body, false);
    }

    public ResultActions put(String url, Object body) throws Exception {
        return send(MockMvcRequestBuilders.put(url), body, true);
    }

    public ResultActions patch(String url, Object body) throws Exception {
        return send(MockMvcRequestBuilders.patch(url), body, true);
    }

    public ResultActions delete(String url) throws Exception {
        return send(MockMvcRequestBuilders.delete(url), null, true);
    }

    /** 로그인 폼 전송(URLSearchParams 와 같은 x-www-form-urlencoded). 토큰은 보내기 전에 새로 받는다. */
    public ResultActions login(String username, String password) throws Exception {
        refreshCsrf();
        return perform(MockMvcRequestBuilders.post("/api/auth/login")
                .contentType(MediaType.APPLICATION_FORM_URLENCODED)
                .param("username", username)
                .param("password", password)
                .header(CSRF_HEADER, csrfToken));
    }

    /** 로그인에 성공해야 하는 경우. 성공 후 새 세션 토큰을 받아 둔다. */
    public TestClient loginOk(String username, String password) throws Exception {
        int status = login(username, password).andReturn().getResponse().getStatus();
        if (status != 200) {
            throw new AssertionError("로그인 실패 status=" + status);
        }
        refreshCsrf();
        return this;
    }

    public ResultActions logout() throws Exception {
        return perform(MockMvcRequestBuilders.post("/api/auth/logout").header(CSRF_HEADER, csrfToken));
    }

    public JsonNode json(ResultActions result) throws Exception {
        return JSON.readTree(result.andReturn().getResponse().getContentAsString());
    }

    public static ObjectMapper mapper() {
        return JSON;
    }

    private ResultActions send(MockHttpServletRequestBuilder builder, Object body, boolean withCsrf) throws Exception {
        if (withCsrf && csrfToken != null) {
            builder.header(CSRF_HEADER, csrfToken);
        }
        if (body != null) {
            builder.contentType(MediaType.APPLICATION_JSON).content(JSON.writeValueAsString(body));
        }
        return perform(builder);
    }
}
