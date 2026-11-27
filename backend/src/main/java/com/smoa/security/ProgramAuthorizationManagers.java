package com.smoa.security;

import java.util.Set;

import org.springframework.security.authorization.AuthorizationDecision;
import org.springframework.security.authorization.AuthorizationManager;
import org.springframework.security.core.Authentication;
import org.springframework.security.web.access.intercept.RequestAuthorizationContext;
import org.springframework.stereotype.Component;

import com.smoa.access.AccessGrant;
import com.smoa.program.Program;
import com.smoa.program.ProgramAction;

import jakarta.servlet.http.HttpServletRequest;

/**
 * URL 계약 기반 인가. 판정은 {@link AccountStateFilter} 가 방금 다시 계산한 {@link AccessGrant} 로만 한다.
 * <ul>
 *   <li>페이지: {@code /pages/<파일>.html} 은 접근 가능한(활성 프로그램 + 활성 패키지 + access/read) 프로그램의 pagePath 와
 *       정확히 같을 때만 허용. 미등록 경로·비활성 프로그램·권한 없음은 거부.</li>
 *   <li>API: {@code /api/programs/{programId}/**}. GET/HEAD=read, POST/PUT/PATCH/DELETE=write,
 *       {@code /api/programs/{programId}/export/**} 는 export(GET/HEAD/POST). 그 밖의 방식은 거부.</li>
 *   <li>{@code /api/admin/**}: 총관리자 시스템 패키지의 계정.</li>
 * </ul>
 */
@Component
public class ProgramAuthorizationManagers {

    static final String PROGRAM_API_PREFIX = "/api/programs/";
    private static final Set<String> READ_METHODS = Set.of("GET", "HEAD");
    private static final Set<String> WRITE_METHODS = Set.of("POST", "PUT", "PATCH", "DELETE");
    private static final Set<String> EXPORT_METHODS = Set.of("GET", "HEAD", "POST");

    private static final AuthorizationDecision DENY = new AuthorizationDecision(false);

    public AuthorizationManager<RequestAuthorizationContext> pages() {
        return (supplier, context) -> {
            AccessGrant grant = grantOf(supplier.get());
            if (grant == null) {
                return DENY;
            }
            String path = pathOf(context.getRequest());
            for (Program program : grant.programs().values()) {
                if (program.pagePath().equals(path)) {
                    return new AuthorizationDecision(
                            grant.canAll(program.programId(), ProgramAction.ACCESS, ProgramAction.READ));
                }
            }
            return DENY;
        };
    }

    public AuthorizationManager<RequestAuthorizationContext> programApi() {
        return (supplier, context) -> {
            AccessGrant grant = grantOf(supplier.get());
            if (grant == null) {
                return DENY;
            }
            HttpServletRequest request = context.getRequest();
            String path = pathOf(request);
            if (!path.startsWith(PROGRAM_API_PREFIX)) {
                return DENY;
            }
            String[] segments = path.substring(PROGRAM_API_PREFIX.length()).split("/", -1);
            String programId = segments[0];
            boolean exportPath = segments.length > 1 && "export".equals(segments[1]);
            String method = request.getMethod();
            ProgramAction required;
            if (exportPath) {
                required = EXPORT_METHODS.contains(method) ? ProgramAction.EXPORT : null;
            } else if (READ_METHODS.contains(method)) {
                required = ProgramAction.READ;
            } else if (WRITE_METHODS.contains(method)) {
                required = ProgramAction.WRITE;
            } else {
                required = null;
            }
            if (required == null) {
                return DENY;
            }
            return new AuthorizationDecision(
                    grant.canAll(programId, ProgramAction.ACCESS, ProgramAction.READ, required));
        };
    }

    public AuthorizationManager<RequestAuthorizationContext> superAdmin() {
        return (supplier, context) -> {
            AccessGrant grant = grantOf(supplier.get());
            return new AuthorizationDecision(grant != null && grant.account().active() && grant.superAdmin());
        };
    }

    private static AccessGrant grantOf(Authentication authentication) {
        return authentication instanceof AccountAuthentication a ? a.grant() : null;
    }

    static String pathOf(HttpServletRequest request) {
        String uri = request.getRequestURI();
        String contextPath = request.getContextPath();
        return contextPath != null && !contextPath.isEmpty() && uri.startsWith(contextPath)
                ? uri.substring(contextPath.length())
                : uri;
    }
}
