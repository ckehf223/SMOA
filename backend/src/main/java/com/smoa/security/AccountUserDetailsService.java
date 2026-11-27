package com.smoa.security;

import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.core.userdetails.UsernameNotFoundException;
import org.springframework.stereotype.Service;

import com.smoa.account.Account;
import com.smoa.account.AccountRepository;

/**
 * 로그인용 사용자 조회. 없는 계정과 비활성 계정을 같은 예외로 처리해 응답·소요 시간으로 구분되지 않게 한다
 * (DaoAuthenticationProvider 가 계정이 없을 때 더미 해시 비교로 시간을 맞춘다).
 */
@Service
public class AccountUserDetailsService implements UserDetailsService {

    private final AccountRepository repository;

    public AccountUserDetailsService(AccountRepository repository) {
        this.repository = repository;
    }

    @Override
    public UserDetails loadUserByUsername(String username) {
        if (username == null || username.isBlank()) {
            throw new UsernameNotFoundException("invalid credentials");
        }
        Account account = repository.findByUsernameKey(Account.usernameKey(username))
                .filter(Account::active)
                .orElseThrow(() -> new UsernameNotFoundException("invalid credentials"));
        return new SmoaUserDetails(account.id(), account.username(), account.passwordHash(),
                account.credentialVersion());
    }
}
