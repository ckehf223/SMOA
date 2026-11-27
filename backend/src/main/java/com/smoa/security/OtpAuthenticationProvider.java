package com.smoa.security;

import java.io.Serializable;

import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.authentication.dao.DaoAuthenticationProvider;
import org.springframework.security.core.CredentialsContainer;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.security.crypto.password.PasswordEncoder;

import com.smoa.otp.OtpService;

import jakarta.servlet.http.HttpServletRequest;

/** Verifies the second factor before Spring creates an authenticated session. */
final class OtpAuthenticationProvider extends DaoAuthenticationProvider {

    private final OtpService otp;

    OtpAuthenticationProvider(AccountUserDetailsService detailsService, PasswordEncoder passwordEncoder,
            OtpService otp) {
        super(detailsService);
        setPasswordEncoder(passwordEncoder);
        this.otp = otp;
    }

    static LoginDetails details(HttpServletRequest request) {
        String[] codes = request.getParameterValues("otp");
        return new LoginDetails(codes == null ? null : codes.length == 1 ? codes[0] : "");
    }

    @Override
    protected void additionalAuthenticationChecks(UserDetails userDetails,
            UsernamePasswordAuthenticationToken authentication) {
        LoginDetails details = authentication.getDetails() instanceof LoginDetails loginDetails ? loginDetails : null;
        try {
            super.additionalAuthenticationChecks(userDetails, authentication);
            if (otp.required()) {
                if (!(userDetails instanceof SmoaUserDetails principal)) {
                    throw new BadCredentialsException("invalid credentials");
                }
                otp.verify(principal.accountId(), details == null ? null : details.code);
                principal.markOtpVerified();
            }
        } finally {
            if (details != null) {
                details.eraseCredentials();
            }
        }
    }

    static final class LoginDetails implements CredentialsContainer, Serializable {
        private static final long serialVersionUID = 1L;
        private transient String code;

        private LoginDetails(String code) {
            this.code = code;
        }

        @Override
        public void eraseCredentials() {
            code = null;
        }

        @Override
        public String toString() {
            return "LoginDetails";
        }
    }
}
