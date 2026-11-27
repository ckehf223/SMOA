package com.smoa.security;

import java.io.IOException;
import java.util.Optional;

import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.authority.AuthorityUtils;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;

import com.smoa.access.AccessService;
import com.smoa.account.Account;
import com.smoa.account.AccountRepository;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpSession;

/**
 * 세션에는 로그인 시점 principal이 있다. 매 요청마다 계정을 다시 읽어 삭제·비활성, credentialVersion 불일치 또는 OTP
 * 검증 표시 누락(필수 상태인 경우)이면 세션을 무효화하고 익명으로 처리한다.
 * (3) 그렇지 않으면 account → 활성 패키지 → 활성 프로그램으로 권한을 다시 계산한 {@link AccountAuthentication} 으로 교체한다.
 * 그래서 패키지·프로그램 변경은 연결된 모든 로그인 계정의 다음 요청부터 반영된다.
 * 인가(AuthorizationFilter) 직전에 실행되도록 등록한다. 이 객체는 Spring bean 으로 등록하지 않는다(서블릿 필터 이중 등록 방지).
 */
public final class AccountStateFilter extends OncePerRequestFilter {

    private final AccountRepository repository;
    private final AccessService access;
    private final boolean otpRequired;

    public AccountStateFilter(AccountRepository repository, AccessService access, boolean otpRequired) {
        this.repository = repository;
        this.access = access;
        this.otpRequired = otpRequired;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        Authentication current = SecurityContextHolder.getContext().getAuthentication();
        if (current != null && !(current instanceof AnonymousAuthenticationToken)) {
            Optional<Account> fresh = Optional.empty();
            if (current.isAuthenticated() && current.getPrincipal() instanceof SmoaUserDetails principal
                    && (!otpRequired || principal.otpVerified())) {
                fresh = repository.findById(principal.accountId())
                        .filter(Account::active)
                        .filter(a -> a.credentialVersion() == principal.credentialVersion());
            }
            SecurityContext context = SecurityContextHolder.createEmptyContext();
            if (fresh.isPresent()) {
                context.setAuthentication(new AccountAuthentication(access.resolve(fresh.get())));
            } else {
                HttpSession session = request.getSession(false);
                if (session != null) {
                    session.invalidate();
                }
                context.setAuthentication(new AnonymousAuthenticationToken("smoa-anonymous", "anonymousUser",
                        AuthorityUtils.createAuthorityList("ROLE_ANONYMOUS")));
            }
            SecurityContextHolder.setContext(context);
        }
        chain.doFilter(request, response);
    }
}
