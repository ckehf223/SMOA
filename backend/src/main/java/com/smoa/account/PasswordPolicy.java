package com.smoa.account;

import java.util.Locale;
import java.util.regex.Pattern;

import com.smoa.common.ApiException;

/** 비밀번호·로그인 ID 규칙. 오류 메시지에는 규칙만 적고 입력값은 넣지 않는다. */
public final class PasswordPolicy {

    public static final Pattern USERNAME = Pattern.compile("[A-Za-z0-9._-]{3,32}");
    public static final int MIN_LENGTH = 12;
    /** BCrypt 는 72바이트까지만 반영하므로 그 안쪽으로 제한한다. */
    public static final int MAX_LENGTH = 64;

    private PasswordPolicy() {
    }

    public static void validateUsername(String username) {
        if (username == null || !USERNAME.matcher(username).matches()) {
            throw ApiException.badRequest("INVALID_USERNAME", "로그인 ID 는 영문·숫자·._- 3~32자여야 합니다.");
        }
    }

    public static void validatePassword(String username, String password) {
        if (password == null || password.length() < MIN_LENGTH || password.length() > MAX_LENGTH) {
            throw weak("비밀번호는 " + MIN_LENGTH + "~" + MAX_LENGTH + "자여야 합니다.");
        }
        if (username != null && password.toLowerCase(Locale.ROOT).contains(username.toLowerCase(Locale.ROOT))) {
            throw weak("비밀번호에 로그인 ID 를 포함할 수 없습니다.");
        }
        int classes = 0;
        if (password.chars().anyMatch(Character::isLowerCase)) {
            classes++;
        }
        if (password.chars().anyMatch(Character::isUpperCase)) {
            classes++;
        }
        if (password.chars().anyMatch(Character::isDigit)) {
            classes++;
        }
        if (password.chars().anyMatch(c -> !Character.isLetterOrDigit(c))) {
            classes++;
        }
        if (classes < 3) {
            throw weak("비밀번호는 소문자·대문자·숫자·기호 중 3종류 이상을 포함해야 합니다.");
        }
    }

    private static ApiException weak(String message) {
        return ApiException.badRequest("WEAK_PASSWORD", message);
    }
}
