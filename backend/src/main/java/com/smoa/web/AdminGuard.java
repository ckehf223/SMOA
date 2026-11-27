package com.smoa.web;

import com.smoa.access.AccessGrant;
import com.smoa.common.ApiException;
import com.smoa.permission.DataScope;
import com.smoa.permission.DistrictKey;
import com.smoa.permission.PermissionPolicy;
import com.smoa.permission.ActionPermission;
import com.smoa.security.CurrentAccount;
import com.smoa.web.dto.Requests.DataScopeRequest;
import com.smoa.web.dto.Requests.PermissionRequest;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 관리 API 공통: 보안 필터 외에 컨트롤러에서도 총관리자 시스템 패키지 여부를 다시 확인하고, 요청 → 도메인 변환을 한다. */
final class AdminGuard {

    private AdminGuard() {
    }

    static AccessGrant superAdmin() {
        AccessGrant grant = CurrentAccount.require();
        if (!grant.account().active() || !grant.superAdmin()) {
            throw ApiException.forbidden("FORBIDDEN", "총관리자만 사용할 수 있습니다.");
        }
        return grant;
    }

    static Map<String, ActionPermission> permissions(Map<String, PermissionRequest> requested) {
        if (requested == null) {
            return null;
        }
        Map<String, ActionPermission> result = new LinkedHashMap<>();
        requested.forEach((key, p) -> result.put(key, p == null ? ActionPermission.NONE
                : new ActionPermission(Boolean.TRUE.equals(p.access()), Boolean.TRUE.equals(p.read()),
                        Boolean.TRUE.equals(p.write()), Boolean.TRUE.equals(p.export()))));
        return result;
    }

    static DataScope scope(PermissionPolicy policy, DataScopeRequest request) {
        if (request == null) {
            return null;
        }
        List<DistrictKey> keys = new ArrayList<>();
        if (request.districts() != null) {
            for (var d : request.districts()) {
                if (!DistrictKey.valid(d.regionCode(), d.districtCode())) {
                    throw ApiException.badRequest("INVALID_SCOPE", "지역·구역 코드 형식이 올바르지 않습니다.");
                }
                keys.add(new DistrictKey(d.regionCode(), d.districtCode()));
            }
        }
        return policy.validateScope(request.type(), keys);
    }
}
