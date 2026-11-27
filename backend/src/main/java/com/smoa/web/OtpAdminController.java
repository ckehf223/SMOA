package com.smoa.web;

import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

import com.smoa.access.AccessGrant;
import com.smoa.account.Account;
import com.smoa.account.AccountAdminService;
import com.smoa.common.ApiException;
import com.smoa.otp.OtpAuthenticationException;
import com.smoa.otp.OtpService;

/** Issues setup credentials for another account until its owner proves possession at sign-in. */
@RestController
public class OtpAdminController {

    private final AccountAdminService accounts;
    private final OtpService otp;

    public OtpAdminController(AccountAdminService accounts, OtpService otp) {
        this.accounts = accounts;
        this.otp = otp;
    }

    public record EnrollmentResponse(String secret) {
        @Override
        public String toString() {
            return "EnrollmentResponse";
        }
    }

    @PostMapping({"/api/admin/accounts/{id}/otp", "/api/admin/users/{id}/otp"})
    public ResponseEntity<EnrollmentResponse> provision(@PathVariable String id) {
        AccessGrant actor = AdminGuard.superAdmin();
        Account target = accounts.get(actor, id);
        if (!otp.required()) {
            throw ApiException.conflict("OTP_DISABLED", "이 서버에서는 OTP 등록을 사용하지 않습니다.");
        }
        if (actor.accountId().equals(target.id())) {
            throw ApiException.forbidden("OTP_SELF_PROVISION_FORBIDDEN", "본인 계정의 OTP는 여기서 발급할 수 없습니다.");
        }
        if (!target.active()) {
            throw ApiException.conflict("OTP_ACCOUNT_INACTIVE", "계정을 활성화한 후 OTP를 발급하세요.");
        }
        if (otp.enrolled(target.id())) {
            throw alreadyEnrolled();
        }
        try {
            return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                    .body(new EnrollmentResponse(otp.provision(target.id())));
        } catch (OtpAuthenticationException failure) {
            if (otp.enrolled(target.id())) {
                throw alreadyEnrolled();
            }
            throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "OTP_UNAVAILABLE",
                    "OTP 발급을 완료하지 못했습니다. 잠시 후 다시 시도하세요.");
        }
    }

    private static ApiException alreadyEnrolled() {
        return ApiException.conflict("OTP_ALREADY_ENROLLED", "이 계정은 이미 OTP를 사용 중입니다.");
    }
}
