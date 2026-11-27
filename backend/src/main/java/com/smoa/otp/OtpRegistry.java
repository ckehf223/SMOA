package com.smoa.otp;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.FileAttribute;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.smoa.crypto.ContactCrypto;

/** Sidecar lock remains attached to one inode across atomic registry replacements. */
final class OtpRegistry {
    record Entry(String secret, long lastStep, boolean enrolled) {}

    private static final String AAD = "SMOA:OTP:REGISTRY:V1";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final TypeReference<Map<String, Entry>> ENTRY_TYPE = new TypeReference<>() {};
    private static final long MAX_REGISTRY_BYTES = 2_000_000;
    private static final boolean POSIX = FileSystems.getDefault().supportedFileAttributeViews().contains("posix");

    private final Path path;
    private final Path lockPath;
    private final ContactCrypto crypto;

    OtpRegistry(Path path, ContactCrypto crypto) throws IOException {
        this.path = path.toAbsolutePath().normalize();
        this.lockPath = this.path.resolveSibling(this.path.getFileName() + ".lock");
        this.crypto = crypto;
        Files.createDirectories(this.path.getParent(), permissions("rwx------"));
    }

    void initialize(Map<String, Entry> seed) throws IOException {
        access(true, entries -> {
            seed.forEach(entries::putIfAbsent);
            return null;
        });
    }

    <T> T access(Function<Map<String, Entry>, T> operation) throws IOException {
        return access(false, operation);
    }

    private <T> T access(boolean startup, Function<Map<String, Entry>, T> operation) throws IOException {
        synchronized (OtpRegistry.class) {
            try (FileChannel channel = FileChannel.open(lockPath, Set.of(StandardOpenOption.CREATE,
                    StandardOpenOption.READ, StandardOpenOption.WRITE), permissions("rw-------"));
                    var ignored = channel.lock()) {
                boolean existing = Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS);
                boolean initialized = channel.size() != 0;
                if (!existing && (!startup || initialized || Files.exists(path, LinkOption.NOFOLLOW_LINKS))) {
                    throw new IOException("OTP 저장소를 사용할 수 없습니다.");
                }
                Map<String, Entry> entries = existing ? read() : new LinkedHashMap<>();
                Map<String, Entry> before = new LinkedHashMap<>(entries);
                T result = operation.apply(entries);
                if (!existing || !entries.equals(before)) {
                    write(entries);
                }
                if (!initialized) {
                    channel.position(0);
                    ByteBuffer marker = ByteBuffer.wrap(new byte[]{1});
                    while (marker.hasRemaining()) {
                        channel.write(marker);
                    }
                    channel.force(true);
                }
                return result;
            }
        }
    }

    private Map<String, Entry> read() throws IOException {
        if (Files.size(path) > MAX_REGISTRY_BYTES) {
            throw new IOException("OTP 저장소가 허용된 크기를 초과했습니다.");
        }
        String json = crypto.open(Files.readString(path), List.of(AAD));
        Map<String, Entry> entries = JSON.readValue(json, ENTRY_TYPE);
        if (entries == null || entries.values().stream().anyMatch(entry -> entry == null
                || entry.secret() == null || entry.secret().isBlank() || entry.lastStep() < -1)) {
            throw new IOException("OTP 저장소 형식이 올바르지 않습니다.");
        }
        return entries;
    }

    private void write(Map<String, Entry> entries) throws IOException {
        byte[] encrypted = crypto.seal(JSON.writeValueAsString(entries), AAD).getBytes(StandardCharsets.UTF_8);
        if (encrypted.length > MAX_REGISTRY_BYTES) {
            throw new IOException("OTP 저장소가 허용된 크기를 초과했습니다.");
        }
        Path temp = Files.createTempFile(path.getParent(), ".otp-", ".tmp", permissions("rw-------"));
        try {
            try (FileChannel channel = FileChannel.open(temp, StandardOpenOption.WRITE)) {
                ByteBuffer bytes = ByteBuffer.wrap(encrypted);
                while (bytes.hasRemaining()) {
                    channel.write(bytes);
                }
                channel.force(true);
            }
            Files.move(temp, path, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            if (POSIX) {
                try (FileChannel directory = FileChannel.open(path.getParent(), StandardOpenOption.READ)) {
                    directory.force(true);
                }
            }
        } finally {
            Files.deleteIfExists(temp);
        }
    }

    private static FileAttribute<?>[] permissions(String value) {
        return POSIX ? new FileAttribute<?>[]{PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString(value))}
                : new FileAttribute<?>[0];
    }
}
